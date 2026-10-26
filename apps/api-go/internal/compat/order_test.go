package compat

import (
	"reflect"
	"testing"
)

func TestPriorityOrderKeepsRotationWithinGroups(t *testing.T) {
	first := func(i int) bool { return i == 1 || i == 4 }
	if got := PriorityOrder(6, 3, first); !reflect.DeepEqual(got, []int{4, 1, 3, 5, 0, 2}) {
		t.Fatal(got)
	}
	if got := PriorityOrder(3, 7, nil); !reflect.DeepEqual(got, []int{1, 2, 0}) {
		t.Fatal(got)
	}
	if PriorityOrder(0, 0, first) != nil {
		t.Fatal("empty")
	}
}
