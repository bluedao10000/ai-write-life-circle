package epub

import (
	"archive/zip"
	"bytes"
	"io"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

type testFile struct {
	name string
	body string
}

func makeEPUB(t *testing.T, files ...testFile) ([]byte, int64) {
	t.Helper()
	var buffer bytes.Buffer
	z := zip.NewWriter(&buffer)
	for _, file := range files {
		w, err := z.Create(file.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = w.Write([]byte(file.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes(), int64(buffer.Len())
}

func standardEPUB(manifest, spine, nav string, extras ...testFile) []testFile {
	files := []testFile{
		{"mimetype", "application/epub+zip"},
		{"META-INF/container.xml", `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`},
		{"OEBPS/content.opf", `<?xml version="1.0"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>北港往事</dc:title><dc:creator>测试作者</dc:creator><dc:language>zh-CN</dc:language></metadata><manifest>` + manifest + `</manifest><spine>` + spine + `</spine></package>`},
		{"OEBPS/nav.xhtml", `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>` + nav + `</ol></nav></body></html>`},
	}
	return append(files, extras...)
}

func parseFiles(t *testing.T, files []testFile) Preview {
	t.Helper()
	b, n := makeEPUB(t, files...)
	preview, err := Parse(bytes.NewReader(b), n)
	if err != nil {
		t.Fatal(err)
	}
	return preview
}

func TestEPUB3MultipleChaptersInOneDocumentAndVolumes(t *testing.T) {
	files := standardEPUB(
		`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>`,
		`<itemref idref="text"/>`,
		`<li><a href="text.xhtml#v1">第一卷 · 北港</a><ol><li><a href="text.xhtml#c1">第一章 雨夜</a></li><li><a href="text.xhtml#c2">第二章 来客</a></li></ol></li><li><a href="text.xhtml#v2">第二卷 · 江宁</a><ol><li><a href="text.xhtml#c3">第三章 船灯</a></li></ol></li>`,
		testFile{"OEBPS/text.xhtml", `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="v1">第一卷 · 北港</h1><h2 id="c1">第一章 雨夜</h2><p>雨落在青石板上。</p><p>钟声从城门传来。</p><h2 id="c2">第二章 来客</h2><p>来客脱下湿透的外衣。</p><blockquote>“有人把灯留在了港口。”</blockquote><h1 id="v2">第二卷 · 江宁</h1><h2 id="c3">第三章 船灯</h2><p>江面亮起第三盏灯。</p><script>window.evil=true</script></body></html>`},
	)
	preview := parseFiles(t, files)
	if preview.Title != "北港往事" || preview.Author != "测试作者" {
		t.Fatalf("metadata: %+v", preview)
	}
	if len(preview.Volumes) != 2 || preview.Volumes[0].Title != "第一卷 · 北港" || preview.Volumes[1].Title != "第二卷 · 江宁" {
		t.Fatalf("volumes: %+v; chapters: %+v", preview.Volumes, preview.Chapters)
	}
	if len(preview.Chapters) != 3 {
		t.Fatalf("chapters: %+v", preview.Chapters)
	}
	if preview.Chapters[0].Title != "第一章 雨夜" || !strings.Contains(preview.Chapters[0].Markdown, "雨落在青石板上") || strings.Contains(preview.Chapters[0].Markdown, "来客脱下") {
		t.Fatalf("chapter 1 boundary: %q", preview.Chapters[0].Markdown)
	}
	if preview.Chapters[1].Volume != 0 || !strings.Contains(preview.Chapters[1].Markdown, "来客脱下") || strings.Contains(preview.Chapters[1].Markdown, "江面亮起") {
		t.Fatalf("chapter 2 boundary: %+v", preview.Chapters[1])
	}
	if preview.Chapters[2].Volume != 1 || !strings.Contains(preview.Chapters[2].Markdown, "江面亮起") || strings.Contains(preview.Chapters[2].Markdown, "window.evil") {
		t.Fatalf("chapter 3 boundary: %+v", preview.Chapters[2])
	}
}

func TestEPUBTopLevelChapterRemainsOutsideInferredVolume(t *testing.T) {
	files := standardEPUB(
		`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="preface" href="preface.xhtml" media-type="application/xhtml+xml"/><item id="v1" href="v1.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>`,
		`<itemref idref="preface"/><itemref idref="v1"/><itemref idref="c1"/>`,
		`<li><a href="preface.xhtml">序章</a></li><li><a href="v1.xhtml">第一卷</a><ol><li><a href="c1.xhtml">第一章</a></li></ol></li>`,
		testFile{"OEBPS/preface.xhtml", `<html><body><h1>序章</h1><p>序章正文。</p></body></html>`},
		testFile{"OEBPS/v1.xhtml", `<html><body><h1>第一卷</h1></body></html>`},
		testFile{"OEBPS/c1.xhtml", `<html><body><h1>第一章</h1><p>卷一正文。</p></body></html>`},
	)
	preview := parseFiles(t, files)
	if len(preview.Volumes) != 1 || len(preview.Chapters) != 2 {
		t.Fatalf("unexpected structure: volumes=%+v chapters=%+v", preview.Volumes, preview.Chapters)
	}
	if preview.Chapters[0].Title != "序章" || preview.Chapters[0].Volume != -1 {
		t.Fatalf("top-level chapter was assigned to a volume: %+v", preview.Chapters[0])
	}
	if preview.Chapters[1].Volume != 0 {
		t.Fatalf("volume chapter was not assigned to volume zero: %+v", preview.Chapters[1])
	}
}

func TestEPUBChapterCanSpanSpineDocuments(t *testing.T) {
	files := standardEPUB(
		`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>`,
		`<itemref idref="a"/><itemref idref="b"/><itemref idref="c"/>`,
		`<li><a href="a.xhtml">第一章</a></li><li><a href="c.xhtml">第二章</a></li>`,
		testFile{"OEBPS/a.xhtml", `<html><body><h1>第一章</h1><p>前半章</p></body></html>`},
		testFile{"OEBPS/b.xhtml", `<html><body><p>后半章仍在第一章</p></body></html>`},
		testFile{"OEBPS/c.xhtml", `<html><body><h1>第二章</h1><p>第二章正文</p></body></html>`},
	)
	preview := parseFiles(t, files)
	if len(preview.Chapters) != 2 {
		t.Fatalf("chapters: %+v", preview.Chapters)
	}
	if !strings.Contains(preview.Chapters[0].Markdown, "前半章") || !strings.Contains(preview.Chapters[0].Markdown, "后半章仍在第一章") {
		t.Fatal(preview.Chapters[0].Markdown)
	}
	if strings.Contains(preview.Chapters[0].Markdown, "第二章") || !strings.Contains(preview.Chapters[1].Markdown, "第二章正文") {
		t.Fatalf("span boundary: %+v", preview.Chapters)
	}
}

func TestEPUB2NCXWithoutTOCUsesStableSpine(t *testing.T) {
	files := []testFile{
		{"mimetype", "application/epub+zip"},
		{"META-INF/container.xml", `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`},
		{"content.opf", `<package version="2.0"><metadata><title>旧格式</title></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="b"/><itemref idref="a"/></spine></package>`},
		{"toc.ncx", `<ncx><navMap><navPoint><navLabel><text>B</text></navLabel><content src="b.xhtml"/></navPoint><navPoint><navLabel><text>A</text></navLabel><content src="a.xhtml"/></navPoint></navMap></ncx>`},
		{"a.xhtml", `<html><head><meta charset="utf-8"></head><body><h1>A</h1><p>甲</p></body></html>`},
		{"b.xhtml", `<html><head><meta charset="utf-8"></head><body><h1>B</h1><p>乙</p></body></html>`},
	}
	preview := parseFiles(t, files)
	if len(preview.Chapters) != 2 || preview.Chapters[0].Title != "B" || preview.Chapters[1].Title != "A" {
		t.Fatalf("spine order: %+v", preview.Chapters)
	}
}

func TestEPUBRejectsTraversalEncryptionAndFixedLayout(t *testing.T) {
	for name, files := range map[string][]testFile{
		"traversal": {
			{"../escape", "bad"},
			{"META-INF/container.xml", "<container><rootfiles><rootfile full-path=\"content.opf\"/></rootfiles></container>"},
		},
		"encryption": {
			{"META-INF/encryption.xml", "<encryption/>"},
			{"META-INF/container.xml", "<container><rootfiles><rootfile full-path=\"content.opf\"/></rootfiles></container>"},
		},
	} {
		b, n := makeEPUB(t, files...)
		if _, err := Parse(bytes.NewReader(b), n); err == nil {
			t.Fatal(name, "was accepted")
		}
	}
	for _, value := range []string{"pre-paginated", "  PRE-PAGINATED \n"} {
		fixed := []testFile{
			{"META-INF/container.xml", `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`},
			{"content.opf", `<package><metadata><meta property="rendition:layout">` + value + `</meta></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>`},
			{"a.xhtml", `<html><body><p>fixed</p></body></html>`},
		}
		b, n := makeEPUB(t, fixed...)
		if _, err := Parse(bytes.NewReader(b), n); err == nil {
			t.Fatalf("fixed layout %q was accepted", value)
		}
	}
	fixedItem := []testFile{
		{"META-INF/container.xml", `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`},
		{"content.opf", `<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml" properties="rendition:layout-pre-paginated"/></manifest><spine><itemref idref="a"/></spine></package>`},
		{"a.xhtml", `<html><body><p>fixed</p></body></html>`},
	}
	b, n := makeEPUB(t, fixedItem...)
	if _, err := Parse(bytes.NewReader(b), n); err == nil {
		t.Fatal("manifest fixed layout was accepted")
	}
	fixedSpineItem := []testFile{
		{"META-INF/container.xml", `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`},
		{"content.opf", `<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a" properties="rendition:layout-pre-paginated"/></spine></package>`},
		{"a.xhtml", `<html><body><p>fixed</p></body></html>`},
	}
	b, n = makeEPUB(t, fixedSpineItem...)
	if _, err := Parse(bytes.NewReader(b), n); err == nil {
		t.Fatal("spine fixed layout was accepted")
	}
}

func TestEPUBAcceptsOrdinaryFilesWithSpuriousExecutableBits(t *testing.T) {
	var buffer bytes.Buffer
	z := zip.NewWriter(&buffer)
	for _, file := range []testFile{
		{"mimetype", "application/epub+zip"},
		{"META-INF/container.xml", `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`},
		{"content.opf", `<package><metadata><title>权限位</title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>`},
		{"a.xhtml", `<html><body><h1>正文</h1><p>权限位不应导致拒绝。</p></body></html>`},
	} {
		header := &zip.FileHeader{Name: file.name, Method: zip.Store}
		header.SetMode(0o755)
		w, err := z.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(file.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(bytes.NewReader(buffer.Bytes()), int64(buffer.Len())); err != nil {
		t.Fatal(err)
	}
}

func TestEPUBNoTOCUsesSpineOrder(t *testing.T) {
	files := []testFile{
		{"META-INF/container.xml", `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`},
		{"content.opf", `<package><metadata><title>无目录</title></metadata><manifest><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>`},
		{"b.xhtml", `<html><body><h1>先</h1><p>第二文件在 spine 中先出现。</p></body></html>`},
		{"a.xhtml", `<html><body><h1>后</h1><p>第一文件在 spine 中后出现。</p></body></html>`},
	}
	preview := parseFiles(t, files)
	if len(preview.Chapters) != 2 || preview.Chapters[0].Title != "先" || preview.Chapters[1].Title != "后" {
		t.Fatalf("%+v", preview.Chapters)
	}
	if len(preview.Warnings) != 1 || preview.Warnings[0].Code != "TOC_MISSING" {
		t.Fatalf("%+v", preview.Warnings)
	}
}

func TestEPUBNestedSectionsDoNotHideParentChapter(t *testing.T) {
	files := standardEPUB(
		`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>`,
		`<itemref idref="text"/>`,
		`<li><a href="text.xhtml#chapter">第一章</a><ol><li><a href="text.xhtml#section">第一节</a></li></ol></li><li><a href="text.xhtml#chapter2">第二章</a></li>`,
		testFile{"OEBPS/text.xhtml", `<html><body><h1 id="chapter">第一章</h1><p>章节正文不能丢失。</p><h2 id="section">第一节</h2><p>小节正文。</p><h1 id="chapter2">第二章</h1><p>下一章。</p></body></html>`},
	)
	preview := parseFiles(t, files)
	if len(preview.Chapters) != 2 || preview.Chapters[0].Title != "第一章" ||
		!strings.Contains(preview.Chapters[0].Markdown, "章节正文不能丢失") ||
		!strings.Contains(preview.Chapters[0].Markdown, "小节正文") ||
		strings.Contains(preview.Chapters[0].Markdown, "下一章") {
		t.Fatalf("nested TOC chapters: %+v", preview.Chapters)
	}
}

func TestEPUBFlatStructuralHeadingWarnsAndKeepsChildChapters(t *testing.T) {
	manifest := `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`
	for i := 1; i <= 3; i++ {
		manifest += `<item id="p` + strconv.Itoa(i) + `" href="p` + strconv.Itoa(i) + `.xhtml" media-type="application/xhtml+xml"/>`
	}
	files := standardEPUB(
		manifest,
		`<itemref idref="p1"/><itemref idref="p2"/><itemref idref="p3"/>`,
		`<li><a href="p1.xhtml">白马出凉州</a><ol><li><a href="p2.xhtml">第一章</a></li><li><a href="p3.xhtml">第二章</a></li></ol></li>`,
		testFile{"OEBPS/p1.xhtml", `<html><body><h1>白马出凉州</h1></body></html>`},
		testFile{"OEBPS/p2.xhtml", `<html><body><h1>第一章</h1><p>第一章正文。</p></body></html>`},
		testFile{"OEBPS/p3.xhtml", `<html><body><h1>第二章</h1><p>第二章正文。</p></body></html>`},
	)
	preview := parseFiles(t, files)
	if len(preview.Volumes) != 1 || preview.Volumes[0].Title != "白马出凉州" {
		t.Fatalf("structural heading was not recognized: %+v", preview.Volumes)
	}
	if len(preview.Chapters) != 2 || preview.Chapters[0].Title != "第一章" || preview.Chapters[1].Title != "第二章" {
		t.Fatalf("child chapters were not preserved: %+v", preview.Chapters)
	}
	found := false
	for _, warning := range preview.Warnings {
		found = found || warning.Code == "TOC_NESTED_STRUCTURE_FLATTENED"
	}
	if !found {
		t.Fatalf("flattening warning missing: %+v", preview.Warnings)
	}
}

func TestEPUBNestedSameFileParentWithOwnProseIsNotTreatedAsStructure(t *testing.T) {
	files := standardEPUB(
		`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>`,
		`<itemref idref="text"/>`,
		`<li><a href="text.xhtml#chapter">第一章</a><ol><li><a href="text.xhtml#section">第一节</a></li></ol></li><li><a href="text.xhtml#chapter2">第二章</a></li>`,
		testFile{"OEBPS/text.xhtml", `<html><body><h1 id="chapter">白马出凉州</h1><p>父章正文必须保留。</p><h2 id="section">第一节</h2><p>小节正文。</p><h1 id="chapter2">第二章</h1><p>下一章。</p></body></html>`},
	)
	preview := parseFiles(t, files)
	if len(preview.Volumes) != 0 || len(preview.Chapters) != 2 ||
		preview.Chapters[0].Title != "第一章" ||
		!strings.Contains(preview.Chapters[0].Markdown, "父章正文必须保留") ||
		!strings.Contains(preview.Chapters[0].Markdown, "小节正文") {
		t.Fatalf("same-file chapter parent was flattened: volumes=%+v chapters=%+v", preview.Volumes, preview.Chapters)
	}
}

func TestEPUBSameTitleChaptersKeepDistinctAnchors(t *testing.T) {
	files := standardEPUB(
		`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>`,
		`<itemref idref="text"/>`,
		`<li><a href="text.xhtml#one">番外</a></li><li><a href="text.xhtml#two">番外</a></li>`,
		testFile{"OEBPS/text.xhtml", `<html><body><h1 id="one">番外</h1><p>第一段同名正文。</p><h1 id="two">番外</h1><p>第二段同名正文。</p></body></html>`},
	)
	preview := parseFiles(t, files)
	if len(preview.Chapters) != 2 ||
		!strings.Contains(preview.Chapters[0].Markdown, "第一段同名正文") ||
		!strings.Contains(preview.Chapters[1].Markdown, "第二段同名正文") {
		t.Fatalf("same-title chapters: %+v", preview.Chapters)
	}
}

func TestEPUBNonLinearContentProducesVisibleWarning(t *testing.T) {
	files := []testFile{
		{"META-INF/container.xml", `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`},
		{"content.opf", `<package><metadata><title>脚注</title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="notes" linear="no"/></spine></package>`},
		{"a.xhtml", `<html><body><h1>正文</h1><p>正文。</p></body></html>`},
		{"notes.xhtml", `<html><body><p>补充脚注。</p></body></html>`},
	}
	preview := parseFiles(t, files)
	found := false
	for _, warning := range preview.Warnings {
		found = found || warning.Code == "NON_LINEAR_CONTENT_SKIPPED"
	}
	if !found {
		t.Fatalf("non-linear warning missing: %+v", preview.Warnings)
	}
}

func TestEPUB2NCXMayUseNonStandardManifestID(t *testing.T) {
	files := []testFile{
		{"META-INF/container.xml", `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`},
		{"content.opf", `<package version="2.0"><metadata><title>EPUB 2</title></metadata><manifest><item id="toc-any-name" href="navigation.ncx" media-type="application/x-dtbncx+xml"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="toc-any-name"><itemref idref="a"/><itemref idref="b"/></spine></package>`},
		{"navigation.ncx", `<ncx><navMap><navPoint><navLabel><text>甲章</text></navLabel><content src="a.xhtml"/></navPoint><navPoint><navLabel><text>乙章</text></navLabel><content src="b.xhtml"/></navPoint></navMap></ncx>`},
		{"a.xhtml", `<html><body><h1>甲</h1><p>甲正文</p></body></html>`},
		{"b.xhtml", `<html><body><h1>乙</h1><p>乙正文</p></body></html>`},
	}
	preview := parseFiles(t, files)
	if len(preview.Chapters) != 2 || preview.Chapters[0].Title != "甲章" || preview.Chapters[1].Title != "乙章" {
		t.Fatalf("NCX was not discovered by media type: %+v", preview.Chapters)
	}
}

func TestEPUBNAVPropertiesMayContainAdditionalTokens(t *testing.T) {
	files := standardEPUB(
		`<item id="contents" href="nav.xhtml" media-type="application/xhtml+xml" properties="scripted nav"/><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>`,
		`<itemref idref="text"/>`,
		`<li><a href="text.xhtml">第一章</a></li>`,
		testFile{"OEBPS/text.xhtml", `<html><body><h1>正文</h1><p>正文。</p></body></html>`},
	)
	preview := parseFiles(t, files)
	if len(preview.Chapters) != 1 || preview.Chapters[0].Title != "第一章" {
		t.Fatalf("NAV properties: %+v", preview.Chapters)
	}
}

func TestEPUBPartialTOCProducesVisibleWarning(t *testing.T) {
	files := standardEPUB(
		`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/>`,
		`<itemref idref="a"/><itemref idref="b"/>`,
		`<li><a href="a.xhtml">第一章</a></li>`,
		testFile{"OEBPS/a.xhtml", `<html><body><h1>第一章</h1><p>甲。</p></body></html>`},
		testFile{"OEBPS/b.xhtml", `<html><body><h1>未收录</h1><p>乙。</p></body></html>`},
	)
	preview := parseFiles(t, files)
	found := false
	for _, warning := range preview.Warnings {
		found = found || warning.Code == "TOC_PARTIAL"
	}
	if !found {
		t.Fatalf("partial TOC warning missing: %+v", preview.Warnings)
	}
}

func TestEPUBPreservesGBKImageAltAndEmphasis(t *testing.T) {
	prefix := `<html><head><meta charset="gbk"></head><body><h1>`
	suffix := `</h1><p><strong>强调</strong>与<em>斜体</em><img src="x.png" alt="插图说明"/></p></body></html>`
	content, err := simplifiedchinese.GBK.NewEncoder().Bytes([]byte(prefix + "你好" + suffix))
	if err != nil {
		t.Fatal(err)
	}
	files := []testFile{
		{"META-INF/container.xml", `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`},
		{"content.opf", `<package><metadata><title>GBK</title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>`},
		{"a.xhtml", string(content)},
	}
	preview := parseFiles(t, files)
	if preview.Chapters[0].Title != "你好" ||
		!strings.Contains(preview.Chapters[0].Markdown, "**强调**") ||
		!strings.Contains(preview.Chapters[0].Markdown, "*斜体*") ||
		!strings.Contains(preview.Chapters[0].Markdown, "〔插图：插图说明〕") {
		t.Fatalf("GBK or inline conversion: %+v", preview.Chapters[0])
	}
}

func TestEPUBRejectsCorruptedCRC(t *testing.T) {
	b, n := makeEPUB(t, []testFile{
		{"META-INF/container.xml", `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`},
		{"content.opf", `<package><metadata><title>损坏</title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>`},
		{"a.xhtml", `<html><body><p>正文。</p></body></html>`},
	}...)
	data := append([]byte(nil), b...)
	// Corrupt the compressed byte while retaining the central-directory CRC so
	// archive/zip must report a checksum failure when the entry is read.
	payload := bytes.Index(data, []byte("正文"))
	if payload < 0 {
		t.Fatal("fixture payload not found")
	}
	data[payload+1] ^= 0x01
	if _, err := Parse(bytes.NewReader(data), n); err == nil {
		t.Fatal("corrupt ZIP entry was accepted")
	}
}

func TestEPUBLEntryReadErrorsAreNeverSwallowed(t *testing.T) {
	var buffer bytes.Buffer
	z := zip.NewWriter(&buffer)
	w, err := z.Create("META-INF/container.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.Write([]byte(`<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`)); err != nil {
		t.Fatal(err)
	}
	if err = z.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(bytes.NewReader(buffer.Bytes()), int64(buffer.Len())); err == nil {
		t.Fatal(io.ErrUnexpectedEOF)
	}
}

func TestEPUBRetainsUncoveredAnchorRanges(t *testing.T) {
	for _, nav := range []string{
		`<li><a href="text.xhtml#c1">第一章</a></li>`,
		`<li><a href="text.xhtml#v1">第一卷</a><ol><li><a href="text.xhtml#c1">第一章</a></li></ol></li><li><a href="text.xhtml#v2">第二卷</a><ol><li><a href="text.xhtml#c2">第二章</a></li></ol></li>`,
	} {
		preview := parseFiles(t, standardEPUB(
			`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>`,
			`<itemref idref="text"/>`, nav,
			testFile{"OEBPS/text.xhtml", `<html><body><h1>作者序</h1><p>序言不能丢失。</p><h1 id="v1">第一卷</h1><p>卷首正文不能丢失。</p><h2 id="c1">第一章</h2><p>第一章正文。</p><h1 id="v2">第二卷</h1><p>第二卷卷首正文。</p><h2 id="c2">第二章</h2><p>第二章正文。</p></body></html>`},
		))
		var all strings.Builder
		for _, c := range preview.Chapters {
			all.WriteString(c.Markdown)
			all.WriteString("\n")
		}
		last := -1
		for _, prose := range []string{"序言不能丢失。", "卷首正文不能丢失。", "第一章正文。", "第二卷卷首正文。", "第二章正文。"} {
			if strings.Count(all.String(), prose) != 1 {
				t.Fatalf("missing/duplicate %q: %+v", prose, preview.Chapters)
			}
			at := strings.Index(all.String(), prose)
			if at <= last {
				t.Fatalf("spine order changed: %s", all.String())
			}
			last = at
		}
		warned := false
		for _, w := range preview.Warnings {
			warned = warned || w.Code == "TOC_UNCOVERED_TEXT"
		}
		if !warned {
			t.Fatal("uncovered text needs a preview warning")
		}
		if preview.Chapters[0].Volume != -1 {
			t.Fatal("preface incorrectly grouped")
		}
	}
}
