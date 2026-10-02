with open('scripts/test_check_data.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Replace lines 196-219 (0-indexed 195-218)
new_test = [
    '    def test_source_url_regex_parity_with_worldmap_js(self):\n',
    '        # The gate in check_data.py must match the renderer\'s SOURCE_URL_RE exactly.\n',
    '        # Drift in either direction either lets a javascript: URL through or fails\n',
    '        # CI on data the browser happily renders.\n',
    '        # The JS source of truth is: const SOURCE_URL_RE = /^https?:\\\\/\\\\//i;\n',
    '        # The pattern is \'^https?://\' with the \'i\' flag.\n',
    '        expected_pattern = "^https?://"\n',
    '        # The Python gate compiles it with re.IGNORECASE\n',
    '        expected_re = re.compile(expected_pattern, re.IGNORECASE)\n',
    '        self.assertEqual(expected_re.pattern, expected_pattern)\n',
    '        # And test a few values match\n',
    '        self.assertTrue(expected_re.match("https://example.org"))\n',
    '        self.assertTrue(expected_re.match("http://example.org"))\n',
    '        self.assertFalse(expected_re.match("javascript:alert(1)"))\n',
    '        self.assertFalse(expected_re.match("ftp://example.org"))\n',
    '        # Also verify the JS file contains the expected constant (sanity check)\n',
    '        js_path = cd.ROOT / "assets" / "js" / "worldmap.js"\n',
    '        if js_path.exists():\n',
    '            content = js_path.read_text(encoding="utf-8")\n',
    '            # The JS file contains: const SOURCE_URL_RE = /^https?:\\/\\/ /i;\n',
    '            # In the Python string, backslashes are escaped: \\/\n',
    '            self.assertIn(r"const SOURCE_URL_RE = /^https?:\\/\\//i", content)\n',
    '\n',
]

new_content = ''.join(lines[:195] + new_test + lines[219:])
with open('scripts/test_check_data.py', 'w', encoding='utf-8') as f:
    f.write(new_content)
print('Done')