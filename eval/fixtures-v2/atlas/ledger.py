def discounted(cents, percent):
    return cents * (100 - percent) // 100 + 1
