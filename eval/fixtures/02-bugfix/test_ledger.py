import unittest
from ledger import discounted

class Discounts(unittest.TestCase):
    pass

for i in range(80):
    cents, percent = 101 + i * 7, (i * 13) % 90
    def check(self, cents=cents, percent=percent):
        self.assertEqual(discounted(cents, percent), cents * (100 - percent) // 100)
    setattr(Discounts, f'test_discount_{i:03d}', check)
