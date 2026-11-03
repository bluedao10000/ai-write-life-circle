package evidence

import "testing"

func TestFindQuote(t *testing.T) {
	for _, tc := range []struct {
		name, text, quote, actual, status string
		start, end                        int
	}{
		{"exact UTF16", "😀林舟回来了。", "林舟回来了。", "林舟回来了。", "unique", 2, 8},
		{"repeated", "😀他留下了。他留下了。", "他留下了。", "他留下了。", "ambiguous", 2, 7},
		{"overlapping", "哈哈哈", "哈哈", "哈哈", "ambiguous", 0, 2},
		{"whitespace and quotes", "😀“林舟\r\n  回来了。”", "  \"林舟 回来了.\"  ", "“林舟\r\n  回来了。”", "unique", 2, 14},
		{"ellipsis", "😀他说：“等等……别走。”", "他说:\"等等...别走.\"", "他说：“等等……别走。”", "unique", 2, 14},
		{"normalized repeated", "“留下！”\n“留下！”", "\"留下!\"", "“留下！”", "ambiguous", 0, 5},
		{"prefer exact", "“留下！”\"留下!\"", "\"留下!\"", "\"留下!\"", "unique", 5, 10},
		{"missing", "林舟回来了。", "林舟离开了。", "", "missing", 0, 0},
		{"empty", "林舟回来了。", " \n\t", "", "missing", 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := FindQuote(tc.text, tc.quote)
			if got.Quote != tc.actual || got.Status != tc.status || got.StartUTF16 != tc.start || got.EndUTF16 != tc.end {
				t.Fatalf("got %+v; want %q %s [%d,%d)", got, tc.actual, tc.status, tc.start, tc.end)
			}
		})
	}
}
