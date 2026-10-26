package compat

// PriorityOrder visits 0..total-1 starting at start (a rotating cursor),
// with every index for which first is true moved ahead of the rest. Each
// group keeps its rotation order, so fairness holds within a group.
func PriorityOrder(total, start int, first func(int) bool) []int {
	if total <= 0 {
		return nil
	}
	start = ((start % total) + total) % total
	head := make([]int, 0, total)
	tail := []int{}
	for n := 0; n < total; n++ {
		i := (start + n) % total
		if first != nil && first(i) {
			head = append(head, i)
		} else {
			tail = append(tail, i)
		}
	}
	return append(head, tail...)
}
