import unittest
from ledger import discounted
class Discount(unittest.TestCase):
    def test_rounding(self):
        for cents in range(101, 131):
            with self.subTest(cents=cents):
                self.assertEqual(discounted(cents, 17), cents * 83 // 100)
