# Build a labeled contact sheet from a public Drive folder of photos, so the
# images can be eyeballed in one go. HEIC is served as JPEG via lh3 ...=s<size>.
# Usage: python scripts/contact-sheet.py <FOLDER_ID> [out.png]
import sys, re, io, urllib.request
from PIL import Image, ImageDraw

FOLDER = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else "contact.png"
UA = {"User-Agent": "Mozilla/5.0"}

def fetch(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()

html = fetch(f"https://drive.google.com/embeddedfolderview?id={FOLDER}#list").decode("utf-8", "ignore")
ids = list(dict.fromkeys(re.findall(r"file/d/([A-Za-z0-9_-]{20,})/", html)))  # unique, in order
print(f"{len(ids)} files")

COLS = int(sys.argv[3]) if len(sys.argv) > 3 else 3
TILE = int(sys.argv[4]) if len(sys.argv) > 4 else 460
LBL = 30
rows = (len(ids) + COLS - 1) // COLS
sheet = Image.new("RGB", (COLS * TILE, rows * (TILE + LBL)), "white")
draw = ImageDraw.Draw(sheet)
for i, fid in enumerate(ids):
    try:
        im = Image.open(io.BytesIO(fetch(f"https://lh3.googleusercontent.com/d/{fid}=s{TILE}"))).convert("RGB")
    except Exception as e:
        im = Image.new("RGB", (TILE, TILE), "#eee"); print("  fail", i + 1, e)
    im.thumbnail((TILE, TILE))
    x, y = (i % COLS) * TILE, (i // COLS) * (TILE + LBL)
    draw.rectangle([x, y, x + TILE, y + TILE + LBL], outline="#999")
    draw.text((x + 6, y + 6), f"#{i+1}", fill="red")
    sheet.paste(im, (x + (TILE - im.width) // 2, y + LBL + (TILE - im.height) // 2))
    draw.text((x + 6, y + TILE + 8), f"#{i+1}  id={fid}", fill="black")
sheet.save(OUT)
print("saved", OUT)
for i, fid in enumerate(ids):
    print(f"#{i+1}\t{fid}")
