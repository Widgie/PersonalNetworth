import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import fetch_prices as fp  # noqa: E402


class ToGbp(unittest.TestCase):
    def test_pence(self):
        self.assertAlmostEqual(fp.to_gbp(308.83, "GBX"), 3.0883)
        self.assertAlmostEqual(fp.to_gbp(24484.61, "GBp"), 244.8461)

    def test_pounds(self):
        self.assertEqual(fp.to_gbp(3.0883, "GBP"), 3.0883)

    def test_unknown_currency_raises(self):
        with self.assertRaises(ValueError):
            fp.to_gbp(1.0, "USD")


class FtParse(unittest.TestCase):
    HTML = ('<li><span class="mod-ui-data-list__label">Price (GBX)</span>'
            '<span class="mod-ui-data-list__value">24,484.61</span></li>'
            '<div>Data delayed at least 15 minutes, as of Nov 12 2026 23:00 GMT.</div>')

    def test_price_and_date(self):
        m = fp.FT_PRICE.search(self.HTML)
        self.assertEqual(m.group(1), "GBX")
        self.assertEqual(float(m.group(2).replace(",", "")), 24484.61)
        self.assertEqual(fp.FT_DATE.search(self.HTML).group(1), "Nov 12 2026")


if __name__ == "__main__":
    unittest.main()
