# Changelog

## 1.0.0

First release.

- **Place a file**: iPhone photos (HEIC, HEIF), camera RAW (DNG, CR2, NEF, ARW), AVIF, TIFF, BMP
  and ICO pictures become a WebP, PNG or JPG image layer; Illustrator (AI) and EPS drawings
  become editable vector layers (SVG) or a PNG; a page of a PDF becomes a PNG, JPG or WebP. The
  layer goes into the selected board (or the board around the selected layer), scaled down to
  fit and centred, or onto the page in the middle of the view, in one undo step.
- **Export selection**: up to 10 selected layers or boards, exported by Penpot as PNG (or PDF)
  and converted to AVIF, WebP or JPG (quality, lossless, or "at most … KB"), TIFF, an ICO
  favicon (16, 32 and 48 px, or one size up to 256 px) or a smaller PDF; each result is
  downloaded.
- Conversions up to 3 credits start on their own; dearer ones ask first.
- Follows Penpot's light and dark themes.
- The Converter Studio API key is kept in the panel's own browser storage; Disconnect deletes it.
- Permissions: `content:read`, `content:write`, `allow:downloads`.
