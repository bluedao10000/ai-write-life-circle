// Package epub safely converts text-first EPUB files into a preview.
// It owns no manuscript storage and never calls a model.
package epub

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"net/url"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	xhtml "golang.org/x/net/html"
	"golang.org/x/text/encoding/simplifiedchinese"
)

const (
	MaxArchiveBytes  = 64 * 1024 * 1024
	MaxExpandedBytes = 256 * 1024 * 1024
	MaxEntryBytes    = 32 * 1024 * 1024
	MaxXMLBytes      = 8 * 1024 * 1024
	MaxEntries       = 10_000
	MaxChapters      = 2_000
	MaxMarkdownBytes = 2 * 1024 * 1024
	MaxWarnings      = 100
)

var (
	ErrUnsupported = errors.New("EPUB is encrypted, fixed layout or otherwise unsupported")
	ErrMalformed   = errors.New("EPUB structure is invalid")
	spaceRE        = regexp.MustCompile(`[ \t\f\v]+`)
	blankRE        = regexp.MustCompile(`\n{3,}`)
	gbkMetaRE      = regexp.MustCompile(`(?i)<meta\b[^>]*(?:charset\s*=\s*["']?\s*gbk\b|content\s*=\s*["'][^"']*charset\s*=\s*gbk\b)`)
)

type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Volume struct {
	Title string `json:"title"`
}

type Chapter struct {
	Title       string `json:"title"`
	Volume      int    `json:"volume"`
	Markdown    string `json:"-"`
	WordCount   int    `json:"wordCount"`
	SourcePart  string `json:"sourcePart"`
	volumeTitle string
}

type Preview struct {
	Title       string    `json:"title"`
	Author      string    `json:"author,omitempty"`
	Language    string    `json:"language,omitempty"`
	Volumes     []Volume  `json:"volumes"`
	Chapters    []Chapter `json:"chapters"`
	Warnings    []Warning `json:"warnings"`
	Fingerprint string    `json:"fingerprint"`
}

type packageDocument struct {
	Version  string `xml:"version,attr"`
	Metadata struct {
		Title     []string `xml:"title"`
		Creator   []string `xml:"creator"`
		Language  []string `xml:"language"`
		Encrypted []string `xml:"encryption"`
		Meta      []struct {
			Property string `xml:"property,attr"`
			Name     string `xml:"name,attr"`
			Content  string `xml:"content,attr"`
			Value    string `xml:",chardata"`
		} `xml:"meta"`
	} `xml:"metadata"`
	Manifest struct {
		Items []struct {
			ID         string `xml:"id,attr"`
			Href       string `xml:"href,attr"`
			MediaType  string `xml:"media-type,attr"`
			Properties string `xml:"properties,attr"`
		} `xml:"item"`
	} `xml:"manifest"`
	Spine struct {
		Items []struct {
			IDRef      string `xml:"idref,attr"`
			Linear     string `xml:"linear,attr"`
			Properties string `xml:"properties,attr"`
		} `xml:"itemref"`
	} `xml:"spine"`
}

type ncxDocument struct {
	NavMap struct {
		Points []ncxPoint `xml:"navPoint"`
	} `xml:"navMap"`
}
type ncxPoint struct {
	Label struct {
		Text string `xml:"text"`
	} `xml:"navLabel"`
	Content struct {
		Src string `xml:"src,attr"`
	} `xml:"content"`
	Children []ncxPoint `xml:"navPoint"`
}

type tocTarget struct {
	Path     string
	Fragment string
	Depth    int
	Title    string
	Group    bool
}

type document struct {
	href    string
	nodes   []textNode
	anchors map[string]int
}
type textNode struct {
	Kind  string
	Text  string
	Start int
}

type archive struct {
	files map[string]*zip.File
}

func Parse(file io.ReaderAt, size int64) (Preview, error) {
	if size <= 0 || size > MaxArchiveBytes {
		return Preview{}, applicationError(413, "EPUB_SIZE_INVALID", "EPUB 必须大于 0 且不超过 64 MiB。")
	}
	z, err := zip.NewReader(file, size)
	if err != nil {
		return Preview{}, applicationError(422, "EPUB_INVALID_ARCHIVE", "文件不是有效的 EPUB ZIP 容器。")
	}
	if len(z.File) == 0 || len(z.File) > MaxEntries {
		return Preview{}, applicationError(422, "EPUB_FILE_COUNT_INVALID", "EPUB 内部文件数量无效或超过限制。")
	}
	a := &archive{files: map[string]*zip.File{}}
	var expanded int64
	for _, f := range z.File {
		// ZIP writers commonly add explicit directory entries. They are not
		// content and must not make an otherwise valid EPUB fail path checks.
		if strings.HasSuffix(f.Name, "/") {
			continue
		}
		p, err := safePath(f.Name)
		if err != nil {
			return Preview{}, applicationError(422, "EPUB_PATH_INVALID", "EPUB 包含不安全或重复的路径。")
		}
		if _, exists := a.files[p]; exists {
			return Preview{}, applicationError(422, "EPUB_PATH_INVALID", "EPUB 包含重复路径。")
		}
		a.files[p] = f
		if f.UncompressedSize64 > MaxEntryBytes {
			return Preview{}, applicationError(413, "EPUB_ENTRY_TOO_LARGE", "EPUB 单个文件超过安全限制。")
		}
		expanded += int64(f.UncompressedSize64)
		if expanded > MaxExpandedBytes {
			return Preview{}, applicationError(413, "EPUB_EXPANDED_SIZE_INVALID", "EPUB 解压总量超过安全限制。")
		}
		if f.FileInfo().Mode()&os.ModeSymlink != 0 ||
			f.FileInfo().Mode()&os.ModeType != 0 {
			return Preview{}, applicationError(422, "EPUB_ENTRY_TYPE_INVALID", "EPUB 不能包含符号链接或特殊文件。")
		}
	}
	container, err := a.read("META-INF/container.xml", 256*1024)
	if err != nil {
		return Preview{}, applicationError(422, "EPUB_CONTAINER_MISSING", "EPUB 缺少 META-INF/container.xml。")
	}
	if _, exists := a.files["META-INF/encryption.xml"]; exists {
		return Preview{}, applicationError(422, "EPUB_DRM_UNSUPPORTED", "暂不支持加密或 DRM 保护的 EPUB。")
	}
	var c struct {
		Rootfiles []struct {
			FullPath  string `xml:"full-path,attr"`
			MediaType string `xml:"media-type,attr"`
		} `xml:"rootfiles>rootfile"`
	}
	if xml.Unmarshal(container, &c) != nil || len(c.Rootfiles) == 0 {
		return Preview{}, applicationError(422, "EPUB_PACKAGE_INVALID", "EPUB 的 OPF 入口无效。")
	}
	packagePath, err := safePath(c.Rootfiles[0].FullPath)
	if err != nil || !strings.HasSuffix(strings.ToLower(packagePath), ".opf") {
		return Preview{}, applicationError(422, "EPUB_PACKAGE_INVALID", "EPUB 的 OPF 路径无效。")
	}
	rawPackage, err := a.read(packagePath, 4*1024*1024)
	if err != nil {
		return Preview{}, applicationError(422, "EPUB_PACKAGE_MISSING", "EPUB 的 OPF 文件不可读取。")
	}
	var pkg packageDocument
	if err = xml.Unmarshal(rawPackage, &pkg); err != nil || len(pkg.Manifest.Items) == 0 || len(pkg.Spine.Items) == 0 {
		return Preview{}, applicationError(422, "EPUB_PACKAGE_INVALID", "EPUB 的 OPF 清单或阅读顺序无效。")
	}
	for _, meta := range pkg.Metadata.Meta {
		key := strings.ToLower(strings.TrimSpace(meta.Property + " " + meta.Name))
		if strings.Contains(key, "rendition:layout") &&
			strings.EqualFold(strings.TrimSpace(meta.Value), "pre-paginated") {
			return Preview{}, applicationError(422, "EPUB_FIXED_LAYOUT_UNSUPPORTED", "暂不支持固定版式 EPUB。")
		}
	}
	base := path.Dir(packagePath)
	manifest := map[string]struct {
		Path      string
		MediaType string
		Props     string
	}{}
	for _, item := range pkg.Manifest.Items {
		p, e := resolve(base, item.Href)
		if e == nil {
			manifest[item.ID] = struct {
				Path      string
				MediaType string
				Props     string
			}{p, strings.ToLower(item.MediaType), item.Properties}
		}
	}
	for _, item := range manifest {
		if hasProperty(item.Props, "rendition:layout-pre-paginated") {
			return Preview{}, applicationError(422, "EPUB_FIXED_LAYOUT_UNSUPPORTED", "暂不支持固定版式 EPUB。")
		}
	}
	preview := Preview{Title: firstText(pkg.Metadata.Title), Author: firstText(pkg.Metadata.Creator), Language: firstText(pkg.Metadata.Language), Volumes: []Volume{}, Chapters: []Chapter{}, Warnings: []Warning{}}
	if preview.Title == "" {
		preview.Title = "导入作品"
		preview.Warnings = warn(preview.Warnings, "MISSING_TITLE", "EPUB 未提供书名，已使用“导入作品”。")
	}
	var toc []tocTarget
	for _, item := range pkg.Manifest.Items {
		if hasProperty(item.Properties, "nav") || strings.EqualFold(item.MediaType, "application/x-dtbncx+xml") || strings.EqualFold(item.ID, "ncx") {
			target, e := resolve(base, item.Href)
			if e != nil {
				continue
			}
			b, e := a.read(target, MaxXMLBytes)
			if e != nil {
				continue
			}
			if strings.EqualFold(item.MediaType, "application/x-dtbncx+xml") || strings.HasSuffix(strings.ToLower(target), ".ncx") {
				toc = append(toc, parseNCX(b, path.Dir(target))...)
			} else {
				toc = append(toc, parseNAV(b, target)...)
			}
		}
	}
	spine := []string{}
	for _, ref := range pkg.Spine.Items {
		item, ok := manifest[ref.IDRef]
		if !ok || !isContentType(item.MediaType) {
			continue
		}
		if hasProperty(ref.Properties, "rendition:layout-pre-paginated") {
			return Preview{}, applicationError(422, "EPUB_FIXED_LAYOUT_UNSUPPORTED", "暂不支持固定版式 EPUB。")
		}
		if strings.EqualFold(strings.TrimSpace(ref.Linear), "no") {
			preview.Warnings = warn(
				preview.Warnings,
				"NON_LINEAR_CONTENT_SKIPPED",
				"EPUB 含阅读顺序之外的补充内容；原文件不是逐字导入，请检查脚注或附录。",
			)
			continue
		}
		if _, ok := a.files[item.Path]; !ok {
			preview.Warnings = warn(preview.Warnings, "MISSING_CONTENT", "EPUB 阅读顺序中的部分正文文件缺失，已跳过。")
			continue
		}
		spine = append(spine, item.Path)
	}
	if len(spine) == 0 {
		return Preview{}, applicationError(422, "EPUB_CONTENT_MISSING", "EPUB 没有可读取的正文段落。")
	}
	docs := make([]document, 0, len(spine))
	for _, href := range spine {
		b, e := a.read(href, MaxEntryBytes)
		if e != nil {
			return Preview{}, applicationError(422, "EPUB_CONTENT_INVALID", "EPUB 正文不可安全解码。")
		}
		nodes, anchors, e := parseXHTML(b)
		if e != nil {
			return Preview{}, applicationError(422, "EPUB_XHTML_INVALID", "EPUB 正文 XHTML 无法解析。")
		}
		docs = append(docs, document{href: href, nodes: nodes, anchors: anchors})
	}
	if len(toc) > 0 {
		preview.Chapters = fromTOC(docs, toc, &preview.Warnings)
		if !tocCoversSpine(docs, toc) {
			preview.Warnings = warn(
				preview.Warnings,
				"TOC_PARTIAL",
				"目录未显式列出全部正文文件；已按 spine 阅读顺序保留正文，请核对章节边界。",
			)
		}
	} else {
		preview.Warnings = warn(preview.Warnings, "TOC_MISSING", "EPUB 缺少可靠目录，章节按 spine 阅读顺序切分。")
		preview.Chapters = fromSpine(docs)
	}
	if len(preview.Chapters) == 0 {
		return Preview{}, applicationError(422, "EPUB_CHAPTER_MISSING", "未能从 EPUB 中识别可导入章节。")
	}
	if len(preview.Chapters) > MaxChapters {
		return Preview{}, applicationError(422, "EPUB_CHAPTER_LIMIT", fmt.Sprintf("EPUB 章节数超过 %d 章上限。", MaxChapters))
	}
	for i := range preview.Chapters {
		c := &preview.Chapters[i]
		c.Markdown = normalizeMarkdown(c.Markdown)
		if c.Markdown == "" {
			return Preview{}, applicationError(422, "EPUB_EMPTY_CHAPTER", "识别出的章节包含空白正文。")
		}
		if len([]byte(c.Markdown)) > MaxMarkdownBytes {
			return Preview{}, applicationError(
				413,
				"EPUB_CHAPTER_TOO_LARGE",
				fmt.Sprintf("第%d章「%s」转换后为 %d 字节，超过单章 2 MiB 上限。源文件：%s。请按目录拆分为较小章节后重新导入。", i+1, c.Title, len([]byte(c.Markdown)), c.SourcePart),
			)
		}
		if !utf8.ValidString(c.Markdown) {
			return Preview{}, applicationError(422, "EPUB_CONTENT_INVALID", "EPUB 正文不是有效 Unicode。")
		}
		c.WordCount = compat.Words(c.Markdown)
	}
	preview.Volumes, preview.Chapters = inferVolumes(preview.Chapters)
	preview.Fingerprint = fingerprint(preview)
	return preview, nil
}

func applicationError(status int, code, detail string) error {
	return &Error{Status: status, Code: code, Detail: detail}
}

// Error is kept local to avoid coupling parsing to HTTP; Transport maps it to a problem.
type Error struct {
	Status int
	Code   string
	Detail string
}

func (e *Error) Error() string { return e.Detail }

func safePath(name string) (string, error) {
	if strings.ContainsRune(name, 0) || strings.Contains(name, "\\") || strings.HasPrefix(name, "/") || strings.Contains(name, ":") {
		return "", ErrMalformed
	}
	clean := path.Clean(name)
	if clean == "." || clean == "" || clean == ".." || strings.HasPrefix(clean, "../") || clean != name || strings.HasSuffix(name, "/") {
		return "", ErrMalformed
	}
	for _, p := range strings.Split(clean, "/") {
		if p == "" || len(p) > 255 {
			return "", ErrMalformed
		}
	}
	return clean, nil
}

func (a *archive) read(name string, limit int64) ([]byte, error) {
	f, ok := a.files[name]
	if !ok {
		return nil, osNotFound
	}
	if int64(f.UncompressedSize64) > limit {
		return nil, errors.New("entry exceeds parse limit")
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, limit+1))
	if err != nil || int64(len(b)) > limit {
		return nil, errors.New("entry content exceeds parse limit")
	}
	return b, nil
}

var osNotFound = errors.New("archive entry absent")

func resolve(base, href string) (string, error) {
	u, err := url.Parse(html.UnescapeString(href))
	if err != nil || u.IsAbs() || u.Host != "" || strings.Contains(u.Path, "\\") {
		return "", ErrMalformed
	}
	p, err := url.PathUnescape(u.Path)
	if err != nil {
		return "", ErrMalformed
	}
	return safePath(path.Clean(path.Join(base, p)))
}

func rootPath(href, base string) (string, string) {
	u, err := url.Parse(href)
	if err != nil {
		return "", ""
	}
	p, err := resolve(base, u.Path)
	if err != nil {
		return "", ""
	}
	fragment, _ := url.PathUnescape(u.Fragment)
	return p, fragment
}

func parseNCX(b []byte, base string) []tocTarget {
	var n ncxDocument
	if xml.Unmarshal(b, &n) != nil {
		return nil
	}
	out := []tocTarget{}
	var walk func([]ncxPoint, int)
	walk = func(points []ncxPoint, depth int) {
		for _, p := range points {
			href, fragment := rootPath(p.Content.Src, base)
			if href != "" {
				out = append(out, tocTarget{
					Path: href, Fragment: fragment, Depth: depth,
					Title: clean(html.UnescapeString(p.Label.Text)),
				})
			}
			walk(p.Children, depth+1)
		}
	}
	walk(n.NavMap.Points, 0)
	return out
}

func parseNAV(b []byte, navPath string) []tocTarget {
	decoded, err := decodeHTML(b)
	if err != nil {
		return nil
	}
	root, err := xhtml.Parse(bytes.NewReader(decoded))
	if err != nil {
		return nil
	}
	base := path.Dir(navPath)
	var out []tocTarget
	var walk func(*xhtml.Node, int, bool)
	walk = func(n *xhtml.Node, depth int, inTOC bool) {
		if n.Type == xhtml.ElementNode && n.Data == "nav" {
			inTOC = false
			for _, attr := range n.Attr {
				if attr.Key == "role" && strings.Contains(attr.Val, "doc-toc") || (attr.Key == "type" || strings.HasSuffix(attr.Key, ":type")) && attr.Val == "toc" {
					inTOC = true
				}
			}
		}
		if inTOC && n.Type == xhtml.ElementNode && n.Data == "a" {
			href := ""
			for _, attr := range n.Attr {
				if attr.Key == "href" {
					href = attr.Val
				}
			}
			p, frag := rootPath(href, base)
			if p != "" {
				out = append(out, tocTarget{
					Path: p, Fragment: frag, Depth: depth,
					Title: clean(textContent(n)),
				})
			}
			return
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			next := depth
			if inTOC && n.Type == xhtml.ElementNode && (n.Data == "ol" || n.Data == "ul") {
				next++
			}
			walk(child, next, inTOC)
		}
	}
	walk(root, 0, false)
	return out
}

func parseXHTML(b []byte) ([]textNode, map[string]int, error) {
	decoded, err := decodeHTML(b)
	if err != nil {
		return nil, nil, err
	}
	if isUTF8(decoded) {
		decoded = bytes.ReplaceAll(decoded, []byte("encoding=\"gbk\""), []byte("encoding=\"utf-8\""))
		decoded = bytes.ReplaceAll(decoded, []byte("encoding='gbk'"), []byte("encoding='utf-8'"))
	}
	root, err := xhtml.Parse(bytes.NewReader(decoded))
	if err != nil {
		return nil, nil, err
	}
	out := []textNode{}
	character := 0
	hidden := 0
	anchors := map[string]int{}
	var walk func(*xhtml.Node, bool)
	walk = func(n *xhtml.Node, pre bool) {
		if n.Type == xhtml.ElementNode {
			for _, attr := range n.Attr {
				if (attr.Key == "id" || attr.Key == "name") && attr.Val != "" {
					if _, exists := anchors[attr.Val]; !exists {
						anchors[attr.Val] = character
					}
				}
			}
			switch strings.ToLower(n.Data) {
			case "head", "script", "style", "svg", "math", "object", "iframe", "video", "audio", "form", "input", "button":
				return
			case "nav":
				hidden++
				defer func() { hidden-- }()
			case "h1", "h2", "h3", "h4", "h5", "h6":
				t := cleanInline(inlineContent(n))
				if hidden == 0 && t != "" {
					level := int(n.Data[len(n.Data)-1] - '0')
					out = append(out, textNode{Kind: "h" + strconv.Itoa(level), Text: t, Start: character})
					character += compat.UTF16Len(t) + 2
				}
				return
			case "p", "blockquote", "li", "figcaption":
				if hidden == 0 {
					t := cleanInline(inlineContent(n))
					if t != "" {
						kind := "p"
						if n.Data == "blockquote" {
							kind = "quote"
						} else if n.Data == "li" {
							kind = "li"
						}
						out = append(out, textNode{Kind: kind, Text: t, Start: character})
						character += compat.UTF16Len(t) + 2
					}
				}
				return
			case "div", "section", "article", "aside", "main", "header", "footer":
				if hidden == 0 && !hasBlockDescendant(n) {
					t := cleanInline(inlineContent(n))
					if t != "" {
						out = append(out, textNode{Kind: "p", Text: t, Start: character})
						character += compat.UTF16Len(t) + 2
					}
					return
				}
			case "hr":
				if hidden == 0 {
					out = append(out, textNode{Kind: "hr", Start: character})
					character += 4
				}
				return
			case "br":
				if hidden == 0 {
					out = append(out, textNode{Kind: "p", Text: "", Start: character})
				}
				return
			case "pre", "code":
				pre = true
			case "img":
				if hidden == 0 {
					t := imagePlaceholder(n)
					out = append(out, textNode{Kind: "p", Text: t, Start: character})
					character += compat.UTF16Len(t) + 2
				}
				return
			}
		}
		if n.Type == xhtml.TextNode {
			t := clean(n.Data)
			if t != "" && hidden == 0 {
				out = append(out, textNode{Kind: "p", Text: t, Start: character})
				character += compat.UTF16Len(t) + 2
			}
			return
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			walk(child, pre)
		}
	}
	walk(root, false)
	return out, anchors, nil
}

func fromSpine(docs []document) []Chapter {
	out := []Chapter{}
	for i, d := range docs {
		md := render(d.nodes)
		if md == "" {
			continue
		}
		title := firstHeading(d.nodes)
		if title == "" {
			title = fmt.Sprintf("第%d章", len(out)+1)
		}
		out = append(out, Chapter{Title: title, Markdown: md, SourcePart: d.href})
		_ = i
	}
	return out
}

func fromTOC(docs []document, toc []tocTarget, warnings *[]Warning) []Chapter {
	positions := map[string]int{}
	for i, d := range docs {
		positions[d.href] = i
	}
	markTOCGroups(toc, docs, positions, warnings)
	valid := []tocTarget{}
	locations := map[string]bool{}
	for _, item := range toc {
		i, ok := positions[item.Path]
		if !ok {
			*warnings = warn(*warnings, "TOC_BROKEN_LINK", "目录中的部分链接未指向正文，已忽略。")
			continue
		}
		item.Path = docs[i].href
		if item.Fragment != "" {
			if _, ok := docs[i].anchors[item.Fragment]; !ok {
				item.Fragment = ""
				*warnings = warn(*warnings, "TOC_ANCHOR_INVALID", "目录中的部分锚点无法定位，已按文件边界切分。")
			}
		}
		location := item.Path + "\x00" + item.Fragment
		if locations[location] {
			continue
		}
		locations[location] = true
		valid = append(valid, item)
	}
	if len(valid) == 0 {
		*warnings = warn(*warnings, "TOC_UNUSABLE", "目录无法可靠对应正文，已按阅读顺序切分。")
		return fromSpine(docs)
	}
	// Any leaf records its nearest container so volume membership follows the
	// TOC tree even when several chapters share one XHTML or span spine files.
	type positionedChapter struct {
		chapter   Chapter
		doc, node int
	}
	positioned := []positionedChapter{}
	covered := make([][]bool, len(docs))
	for i := range docs {
		covered[i] = make([]bool, len(docs[i].nodes))
	}
	for i, item := range valid {
		if item.Group {
			continue
		}
		// A non-volume TOC parent is a chapter and nested entries are its
		// sections. They remain inside the parent range rather than becoming
		// duplicate chapters.
		section := false
		for j := i - 1; j >= 0; j-- {
			if valid[j].Depth < item.Depth {
				section = !valid[j].Group
				break
			}
		}
		if section {
			continue
		}
		volumeTitle := ""
		for j := i - 1; j >= 0; j-- {
			if valid[j].Group && valid[j].Depth < item.Depth {
				volumeTitle = valid[j].Title
				break
			}
		}
		startDoc := positions[item.Path]
		if startDoc >= len(docs) {
			continue
		}
		start := 0
		if item.Fragment != "" {
			start = docs[startDoc].anchors[item.Fragment]
		}
		endDoc := len(docs)
		end := 0
		next := len(valid)
		for j := i + 1; j < len(valid); j++ {
			// TOC entries nested below the current chapter are section anchors,
			// not chapter boundaries. The next sibling chapter or an ancestor
			// container (for example the next volume) closes the current range.
			if valid[j].Depth <= item.Depth {
				next = j
				break
			}
		}
		if next < len(valid) {
			endDoc = positions[valid[next].Path]
			end = 0
			if valid[next].Fragment != "" {
				end = docs[endDoc].anchors[valid[next].Fragment]
			}
		} else if endDoc == len(docs) {
			// A chapter that reaches the end spans every remaining spine item.
			// flatten deliberately excludes an exclusive end document, so use the
			// end of the final document as the explicit boundary.
			endDoc = len(docs) - 1
			// end is a character sentinel, not a node count. nodeIndex maps this
			// value beyond every Start position and returns len(nodes).
			end = 1 << 30
		}
		if endDoc < startDoc || endDoc == startDoc && end == start && item.Fragment != "" {
			*warnings = warn(*warnings, "TOC_ORDER_INVALID", "目录与阅读顺序冲突，已使用可靠目录项并忽略异常顺序。")
			continue
		}
		title := item.Title
		nodes := []textNode{}
		for d := startDoc; d <= endDoc && d < len(docs); d++ {
			from, to := 0, len(docs[d].nodes)
			if d == startDoc {
				from = nodeIndex(docs[d].nodes, start)
			}
			if d == endDoc {
				to = nodeIndex(docs[d].nodes, end)
			}
			for n := from; n < to; n++ {
				if covered[d][n] {
					*warnings = warn(*warnings, "TOC_ORDER_INVALID", "目录范围重叠，重复正文已按阅读顺序去重；请核对章节边界。")
					continue
				}
				covered[d][n] = true
				nodes = append(nodes, docs[d].nodes[n])
			}
		}
		md := render(nodes)
		if title == "" {
			title = firstHeading(nodes)
		}
		if title == "" {
			title = fmt.Sprintf("第%d章", len(positioned)+1)
		}
		positioned = append(positioned, positionedChapter{Chapter{Title: title, Markdown: md, SourcePart: docs[startDoc].href, volumeTitle: volumeTitle}, startDoc, nodeIndex(docs[startDoc].nodes, start)})
	}
	// Account for actual node ranges, including prose before the first anchor
	// and between structural TOC containers. File-level coverage cannot detect it.
	for d, doc := range docs {
		for n := 0; n < len(doc.nodes); {
			if covered[d][n] {
				n++
				continue
			}
			start := n
			for n < len(doc.nodes) && !covered[d][n] {
				n++
			}
			nodes := doc.nodes[start:n]
			md := render(nodes)
			if !hasSubstantiveProse(nodes) && !strings.Contains(md, "〔插图") {
				continue
			}
			title := firstHeading(nodes)
			if title == "" {
				title = "补充正文"
			}
			positioned = append(positioned, positionedChapter{Chapter{Title: title, Markdown: md, SourcePart: doc.href}, d, start})
			*warnings = warn(*warnings, "TOC_UNCOVERED_TEXT", "目录锚点未覆盖的正文已保留为补充章节，请核对标题与章节边界。")
		}
	}
	sort.SliceStable(positioned, func(i, j int) bool {
		if positioned[i].doc != positioned[j].doc {
			return positioned[i].doc < positioned[j].doc
		}
		return positioned[i].node < positioned[j].node
	})
	out := []Chapter{}
	for _, item := range positioned {
		if item.chapter.Markdown != "" {
			out = append(out, item.chapter)
		}
	}
	return out
}

// markTOCGroups separates real volume containers from chapter parents that
// own nested section links. A child pointing to another spine document is a
// strong signal that the parent only labels a structural division. Keep the
// stricter same-document case as a chapter so prose and section anchors are
// never split apart without an explicit volume title.
func markTOCGroups(toc []tocTarget, docs []document, positions map[string]int, warnings *[]Warning) {
	for i := range toc {
		if i+1 >= len(toc) || toc[i+1].Depth <= toc[i].Depth {
			continue
		}
		if looksVolume(toc[i].Title) {
			toc[i].Group = true
			continue
		}
		child := toc[i+1]
		if child.Path == toc[i].Path {
			continue
		}
		index, ok := positions[toc[i].Path]
		if !ok || hasSubstantiveProse(docs[index].nodes) {
			continue
		}
		toc[i].Group = true
		*warnings = warn(
			*warnings,
			"TOC_NESTED_STRUCTURE_FLATTENED",
			"目录中的多级标题未标明“卷/部/篇”，已根据独立子章节将其作为结构标题处理；请核对卷名与章节顺序。",
		)
	}
}

func hasSubstantiveProse(nodes []textNode) bool {
	for _, node := range nodes {
		if len(node.Kind) == 2 && node.Kind[0] == 'h' && node.Kind[1] >= '1' && node.Kind[1] <= '6' {
			continue
		}
		text := strings.TrimSpace(node.Text)
		if text == "" || strings.HasPrefix(text, "〔插图") && strings.HasSuffix(text, "〕") || node.Kind == "hr" {
			continue
		}
		return true
	}
	return false
}

func tocCoversSpine(docs []document, toc []tocTarget) bool {
	seen := map[string]bool{}
	for _, item := range toc {
		seen[item.Path] = true
	}
	for _, doc := range docs {
		if !seen[doc.href] {
			return false
		}
	}
	return true
}

func nodeIndex(nodes []textNode, character int) int {
	for i, n := range nodes {
		if n.Start >= character {
			return i
		}
	}
	return len(nodes)
}

func inferVolumes(in []Chapter) ([]Volume, []Chapter) {
	out := []Volume{}
	chapters := make([]Chapter, len(in))
	indices := map[string]int{}
	for i, c := range in {
		// Zero is a valid inferred volume index. Reserve it for grouped
		// chapters and use -1 to keep prefaces or other top-level chapters
		// outside every volume.
		c.Volume = -1
		title := clean(c.volumeTitle)
		if title == "" && looksVolume(c.Title) {
			title = clean(c.Title)
		}
		if title != "" {
			index, ok := indices[title]
			if !ok {
				index = len(out)
				indices[title] = index
				out = append(out, Volume{Title: title})
			}
			c.Volume = index
			c.volumeTitle = title
			chapters[i] = c
			continue
		}
		chapters[i] = c
	}
	return out, chapters
}

func looksVolume(s string) bool {
	s = strings.TrimSpace(s)
	return strings.HasPrefix(s, "第") && (strings.Contains(s, "卷") || strings.Contains(s, "部") || strings.Contains(s, "篇")) ||
		strings.HasPrefix(strings.ToLower(s), "volume ") || strings.HasPrefix(strings.ToLower(s), "part ") ||
		strings.HasPrefix(strings.ToLower(s), "book ")
}

func render(nodes []textNode) string {
	var out []string
	for _, n := range nodes {
		if n.Text == "" {
			continue
		}
		switch {
		case len(n.Kind) == 2 && n.Kind[0] == 'h' && n.Kind[1] >= '1' && n.Kind[1] <= '6':
			level := int(n.Kind[1] - '0')
			out = append(out, strings.Repeat("#", level)+" "+n.Text)
		case n.Kind == "quote":
			out = append(out, "> "+n.Text)
		case n.Kind == "li":
			out = append(out, "- "+n.Text)
		case n.Kind == "hr":
			out = append(out, "---")
		default:
			out = append(out, n.Text)
		}
	}
	return strings.Join(out, "\n\n")
}

func normalizeMarkdown(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.ReplaceAll(s, "\u0000", "")
	s = strings.ReplaceAll(s, "\uFEFF", "")
	s = blankRE.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

func decodeHTML(b []byte) ([]byte, error) {
	b = bytes.TrimPrefix(b, []byte{0xef, 0xbb, 0xbf})
	decl := bytes.ToLower(b)
	if bytes.Contains(decl, []byte(`encoding="gbk"`)) ||
		bytes.Contains(decl, []byte(`encoding='gbk'`)) ||
		gbkMetaRE.Match(b) {
		if !isUTF8(b) {
			return simplifiedchinese.GBK.NewDecoder().Bytes(b)
		}
	}
	return b, nil
}

func isUTF8(b []byte) bool {
	for len(b) > 0 {
		if b[0] < 0x80 {
			b = b[1:]
			continue
		}
		r, n := utf8.DecodeRune(b)
		if r == utf8.RuneError && n == 1 {
			return false
		}
		b = b[n:]
	}
	return true
}

func firstText(values []string) string {
	for _, value := range values {
		if value = clean(value); value != "" {
			return value
		}
	}
	return ""
}

func firstHeading(nodes []textNode) string {
	for _, n := range nodes {
		if len(n.Kind) == 2 && n.Kind[0] == 'h' && n.Kind[1] >= '1' && n.Kind[1] <= '6' && n.Text != "" {
			return n.Text
		}
	}
	return ""
}

func textContent(n *xhtml.Node) string {
	var b strings.Builder
	var walk func(*xhtml.Node)
	walk = func(v *xhtml.Node) {
		if v.Type == xhtml.TextNode {
			b.WriteString(v.Data)
			b.WriteByte(' ')
		}
		for c := v.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}

func inlineContent(root *xhtml.Node) string {
	var b strings.Builder
	var walk func(*xhtml.Node)
	walk = func(n *xhtml.Node) {
		if n.Type == xhtml.TextNode {
			b.WriteString(escapeMarkdown(n.Data))
			return
		}
		if n.Type == xhtml.ElementNode {
			switch strings.ToLower(n.Data) {
			case "script", "style", "iframe", "object", "form", "input", "button":
				return
			case "strong", "b":
				b.WriteString("**")
				children(walk, n)
				b.WriteString("**")
				return
			case "em", "i", "cite":
				b.WriteString("*")
				children(walk, n)
				b.WriteString("*")
				return
			case "code", "kbd", "samp":
				b.WriteByte('`')
				children(walk, n)
				b.WriteByte('`')
				return
			case "sup":
				b.WriteString("[^")
				children(walk, n)
				b.WriteByte(']')
				return
			case "sub":
				b.WriteString("<sub>")
				children(walk, n)
				b.WriteString("</sub>")
				return
			case "br":
				b.WriteByte(' ')
				return
			case "img":
				b.WriteString(imagePlaceholder(n))
				return
			}
		}
		children(walk, n)
	}
	walk(root)
	return b.String()
}

func imagePlaceholder(n *xhtml.Node) string {
	alt := ""
	for _, a := range n.Attr {
		if a.Key == "alt" {
			alt = clean(a.Val)
		}
		if a.Key == "src" && strings.HasPrefix(strings.ToLower(strings.TrimSpace(a.Val)), "data:") {
			alt = "内嵌插图"
		}
	}
	if alt != "" {
		return "〔插图：" + alt + "〕"
	}
	return "〔插图〕"
}

func children(walk func(*xhtml.Node), n *xhtml.Node) {
	for child := n.FirstChild; child != nil; child = child.NextSibling {
		walk(child)
	}
}

func hasBlockDescendant(root *xhtml.Node) bool {
	found := false
	var walk func(*xhtml.Node)
	walk = func(n *xhtml.Node) {
		if found || n == root {
			for child := n.FirstChild; child != nil && !found; child = child.NextSibling {
				walk(child)
			}
			return
		}
		if n.Type == xhtml.ElementNode {
			switch strings.ToLower(n.Data) {
			case "p", "div", "section", "article", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "li", "ul", "ol", "pre", "figure":
				found = true
				return
			}
		}
		for child := n.FirstChild; child != nil && !found; child = child.NextSibling {
			walk(child)
		}
	}
	walk(root)
	return found
}

var markdownSpecialRE = regexp.MustCompile(`([\\*_[\]<>` + "`" + `])`)

func escapeMarkdown(s string) string {
	return markdownSpecialRE.ReplaceAllString(s, `\$1`)
}

func clean(s string) string {
	s = html.UnescapeString(s)
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, s)
	return strings.TrimSpace(spaceRE.ReplaceAllString(s, " "))
}

func cleanInline(s string) string {
	s = clean(s)
	s = strings.ReplaceAll(s, "  ", " ")
	return s
}

func isContentType(mt string) bool {
	return mt == "application/xhtml+xml" || mt == "text/html" || mt == "application/xml" || mt == "text/xml"
}

func hasProperty(properties, wanted string) bool {
	for _, property := range strings.Fields(strings.ToLower(properties)) {
		if property == wanted {
			return true
		}
	}
	return false
}

func warn(in []Warning, code, message string) []Warning {
	for _, w := range in {
		if w.Code == code {
			return in
		}
	}
	if len(in) >= MaxWarnings {
		return in
	}
	return append(in, Warning{code, message})
}

func fingerprint(p Preview) string {
	h := compat.Hash(p.Title + "\x00" + p.Author + "\x00" + p.Language)
	for _, v := range p.Volumes {
		h = compat.Hash(h + "\x00v\x00" + v.Title)
	}
	for _, c := range p.Chapters {
		h = compat.Hash(h + "\x00c\x00" + c.Title + "\x00" + strconv.Itoa(c.Volume) + "\x00" + c.Markdown)
	}
	return h
}
