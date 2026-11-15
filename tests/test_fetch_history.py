import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import fetch_history as fh  # noqa: E402


class FtRows(unittest.TestCase):
    FRAG = ('<tr><td class="mod-ui-table__cell--text"><span class="mod-ui-hide-small-below">Friday, November 13, 2026</span>'
            '<span class="mod-ui-hide-medium-above">Fri, Nov 13, 2026</span></td>'
            '<td>1,150.00</td><td>1,160.00</td><td>1,140.00</td><td>1,154.00</td><td>--</td></tr>'
            '<tr><td><span>Thursday, November 12, 2026</span></td><td>1</td><td>1</td><td>1</td><td>1,149.50</td><td>--</td></tr>')

    def test_parse_pence(self):
        self.assertEqual(fh.parse_ft_rows(self.FRAG, "GBX"), {"2026-11-13": 11.54, "2026-11-12": 11.495})

    def test_parse_pounds(self):
        self.assertEqual(fh.parse_ft_rows(self.FRAG, "GBP")["2026-11-13"], 1154.0)


if __name__ == "__main__":
    unittest.main()
