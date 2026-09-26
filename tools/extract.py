"""Parse the official NSB high-school sample-question PDFs into data/questions.json.

Usage: python3 tools/extract.py <pdf_dir> <link_names.json>
PDF files are named "Sample-Set-N__<file>.pdf" (see tools/download.sh).
Superscripts/subscripts are recovered from span size + baseline and emitted as
inline LaTeX \\( ... \\). Questions containing images or stacked/equation-editor
math also get a PNG crop of the original region (data/img/...).
"""
import collections
import glob
import json
import os
import re
import sys

import fitz

OUT = os.path.join(os.path.dirname(__file__), "..", "data")
SUP, ESUP, SUB, ESUB = "\x01", "\x02", "\x03", "\x04"

SYMBOL_MAP = {0xF061: "α", 0xF0B0: "°", 0xF0D7: "×", 0xF02D: "−", 0xF0E0: "→", 0x00: ""}
MATH_ALNUM = {}
for base, start in (("A", 0x1D434), ("a", 0x1D44E)):  # math italic
    for i in range(26):
        MATH_ALNUM[start + i] = chr(ord(base) + i)
MATH_ALNUM[0x210E] = "h"
MATH_ALNUM.update({0x1D6FC: "α", 0x1D6FD: "β", 0x1D6FE: "γ", 0x1D6FF: "δ", 0x1D703: "θ", 0x1D706: "λ", 0x1D707: "μ",
                   0x1D70B: "π", 0x1D70C: "ρ", 0x1D70E: "σ", 0x1D711: "φ", 0x1D714: "ω", 0x2DA: "°"})

CATS = {
    "BIOLOGY": "Biology", "LIFE SCIENCE": "Biology", "CHEMISTRY": "Chemistry", "PHYSICS": "Physics",
    "MATH": "Math", "MATHEMATICS": "Math", "ENERGY": "Energy", "GENERAL SCIENCE": "General Science",
    "EARTH AND SPACE": "Earth and Space", "EARTH ANDE SPACE": "Earth and Space",
    "EARTH & SPACE": "Earth and Space", "EARTH SCIENCE": "Earth and Space", "ASTRONOMY": "Earth and Space",
}
CAT_RE = "|".join(sorted((re.escape(c).replace(r"\ ", r"\s*") for c in CATS), key=len, reverse=True))
HEAD_RE = re.compile(
    r"^\s*(\d+)\s*[\).](?:\s*\))?\s*(" + CAT_RE + r")\s*[–—\-:]?\s*(SHORT(?:[\s\-]*ANSWER)?|MUL?T?I?PLE[\s\-]*CHOI?C?E?)\s*[–—\-:.]?\s*",
    re.I)
CHOICE_RE = re.compile(r"^\s*([WXYZ])\)\s*")
SEP_RE = re.compile(r"^[\s~*_\-=–—]{5,}$")
FOOT_RE = re.compile(r"(Page\s+\d+\s*$|NSB®|^\s*(High School\s+)?Round\s+\S+\s+Page|Regional High School)", re.I)


def clean_chars(t):
    # Word equation fonts emit each math-italic glyph twice ("𝑥𝑥")
    t = re.sub(r"([\U0001D400-\U0001D7FF])\1", r"\1", t)
    out = []
    for ch in t:
        o = ord(ch)
        if o in SYMBOL_MAP:
            out.append(SYMBOL_MAP[o])
        elif o in MATH_ALNUM:
            out.append(MATH_ALNUM[o])
        elif 0xF020 <= o <= 0xF0FF:
            out.append(chr(o - 0xF000))
        else:
            out.append(ch)
    return "".join(out)


def page_rows(page):
    """Return visual rows [{y0,y1,x0,x1,text,fonts}] with sup/sub markers."""
    spans = []
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                t = clean_chars(s["text"])
                if not t:
                    continue
                spans.append({"t": t, "size": s["size"], "bbox": s["bbox"], "base": s["origin"][1], "font": s["font"]})
    if not spans:
        return []
    sizes = collections.Counter()
    for s in spans:
        sizes[round(s["size"], 1)] += len(s["t"].strip())
    body = sizes.most_common(1)[0][0]
    big = [s for s in spans if s["size"] >= 0.82 * body]
    small = [s for s in spans if s["size"] < 0.82 * body]
    rows = []
    for s in sorted(big, key=lambda s: s["base"]):
        for r in rows:
            if abs(r["base"] - s["base"]) <= 2.0:
                r["spans"].append(s)
                break
        else:
            rows.append({"base": s["base"], "size": s["size"], "spans": [s]})
    for s in small:
        cy = (s["bbox"][1] + s["bbox"][3]) / 2
        best = None
        for r in rows:
            top, bot = r["base"] - 0.95 * r["size"], r["base"] + 0.45 * r["size"]
            if top <= cy <= bot and s["t"].strip():
                d = abs(cy - (r["base"] - 0.35 * r["size"]))
                if best is None or d < best[0]:
                    best = (d, r)
        if best:
            r = best[1]
            kind = "sup" if s["base"] < r["base"] - 0.8 else ("sub" if s["base"] > r["base"] + 0.8 else "")
            if s["t"].strip() in ("®", "™", "©"):
                kind = ""
            s["kind"] = kind
            r["spans"].append(s)
        else:
            rows.append({"base": s["base"], "size": s["size"], "spans": [s]})
    out = []
    for r in sorted(rows, key=lambda r: r["base"]):
        ss = sorted(r["spans"], key=lambda s: s["bbox"][0])
        text, prev = "", None
        for s in ss:
            t = s["t"]
            kind = s.get("kind", "")
            if prev is not None:
                gap = s["bbox"][0] - prev["bbox"][2]
                if gap > 0.22 * r["size"] and not text.endswith(" ") and not t.startswith(" ") and not kind:
                    text += " "
            if kind == "sup":
                st = t.strip()
                if st in ("o", "0") and re.search(r"\d\s*$", text):
                    text = text.rstrip() + "°"
                else:
                    text += SUP + st + ESUP
            elif kind == "sub":
                text += SUB + t.strip() + ESUB
            else:
                text += t
            prev = s
        text = re.sub(ESUP + SUP, "", re.sub(ESUB + SUB, "", text))
        x0 = min(s["bbox"][0] for s in ss)
        x1 = max(s["bbox"][2] for s in ss)
        y0 = min(s["bbox"][1] for s in ss)
        y1 = max(s["bbox"][3] for s in ss)
        out.append({"y0": y0, "y1": y1, "x0": x0, "x1": x1, "text": text.rstrip(),
                    "fonts": {s["font"] for s in ss}, "size": r["size"]})
    return out


def is_math_row(t):
    s = re.sub(r"[\x01-\x04]", "", t).strip()
    return 0 < len(s) <= 22 and not re.search(r"[A-Za-z]{4,}", s) and not CHOICE_RE.match(s) \
        and not re.match(r"^(ANSWER|TOSS|BONUS)", s, re.I)


def math_escape(s):
    s = s.replace("–", "-").replace("−", "-").replace("\\", "\\backslash ")
    return re.sub(r"([%#&_{}$^])", r"\\\1", s)


def script(s):
    s = s.strip()
    if re.fullmatch(r"[A-Za-z]{2,}", s):
        return "\\text{" + s + "}"
    return math_escape(s)


def to_latex(t):
    # numerator raised + denominator lowered with no base = stacked fraction
    t = re.sub(r"(?<![A-Za-z0-9)\]])" + SUP + "([^\x01-\x04]+?)" + ESUP + r"\s?" + SUB + "([^\x01-\x04]+?)" + ESUB,
               lambda m: "\\(\\tfrac{" + math_escape(m.group(1).strip()) + "}{" + math_escape(m.group(2).strip()) + "}\\)", t)
    t = re.sub(SUP + "(.*?)" + ESUP, lambda m: "\\(^{" + script(m.group(1)) + "}\\)", t)
    t = re.sub(SUB + "(.*?)" + ESUB, lambda m: "\\(_{" + script(m.group(1)) + "}\\)", t)
    return re.sub(r"[\x01-\x04]", "", t)


GARBLED = "[\u0590-\u05FF\u0700-\u0DFF\u1200-\u137F]"


def degarble(t):
    """Drop tokens from equation fonts with broken unicode maps; the PDF crop shows them."""
    if not re.search(GARBLED, t):
        return t, False
    t = re.sub(r"\\\((?:(?!\\\)).)*?" + GARBLED + r".*?\\\)", " ", t)
    t = " ".join(w for w in t.split(" ") if not re.search(GARBLED, w))
    return t, True


def norm_space(t):
    return re.sub(r"[ \t ]+", " ", t.replace("à→", "→")).strip()


def parse_pdf(path, set_no, round_name, img_dir):
    doc = fitz.open(path)
    items = []  # (kind, row, page)
    for pno, page in enumerate(doc):
        imgs = [fitz.Rect(i["bbox"]) for i in page.get_image_info()]
        h = page.rect.height
        for r in page_rows(page):
            plain = re.sub(r"[\x01-\x04]", "", r["text"]).strip()
            if not plain:
                continue
            if r["y0"] > h - 55 or FOOT_RE.search(plain) and r["y0"] > h * 0.85:
                continue
            if SEP_RE.match(plain):
                items.append(("sep", r, pno))
                continue
            r["img"] = any(fitz.Rect(r["x0"] - 2, r["y0"] - 4, r["x1"] + 40, r["y1"] + 4).intersects(im) for im in imgs)
            if re.fullmatch(r"TOSS[\s\-–]*UP", plain, re.I):
                items.append(("tossup", r, pno))
            elif re.fullmatch(r"BONUS", plain, re.I):
                items.append(("bonus", r, pno))
            else:
                items.append(("row", r, pno))
        # image-only lines (equation images standing alone) mark the enclosing region
        for im in imgs:
            items.append(("image", {"y0": im.y0, "y1": im.y1, "x0": im.x0, "x1": im.x1}, pno))
    # re-sort so standalone images interleave by position
    order = {id(it): i for i, it in enumerate(items)}
    items.sort(key=lambda it: (it[2], it[1]["y0"] if it[0] == "image" else it[1]["y0"], order[id(it)]))

    questions, cur, part = [], None, None
    for kind, r, pno in items:
        if kind in ("tossup", "bonus"):
            part = kind
            cur = None
            continue
        if kind == "sep":
            cur = None
            continue
        if kind == "image":
            if cur:
                cur["regions"][cur["state"]].append((pno, r))
                cur["flag"][cur["state"]] = 2
            continue
        plain = re.sub(r"[\x01-\x04]", "", r["text"])
        m = HEAD_RE.match(plain)
        if m and part:
            cat_raw = re.sub(r"\s+", " ", m.group(2).upper())
            cat_raw = next(k for k in CATS if re.sub(r"\s", "", k) == re.sub(r"\s", "", cat_raw))
            # strip header from the marked-up text (header has no sup/sub markers)
            body = r["text"][len(m.group(0)):] if r["text"].startswith(plain[:len(m.group(0))]) else plain[len(m.group(0)):]
            cur = {"part": part, "num": int(m.group(1)), "category": CATS[cat_raw],
                   "sub": cat_raw.title() if CATS[cat_raw] == "Earth and Space" and cat_raw in ("EARTH SCIENCE", "ASTRONOMY") else None,
                   "format": "mc" if m.group(3).upper().startswith("M") else "sa",
                   "lines": [body], "ans": [], "state": "q", "regions": {"q": [(pno, r)], "a": []},
                   "flag": {"q": 0, "a": 0}}  # 0 none, 1 weak (heuristic), 2 strong
            questions.append(cur)
            part = None  # one question per marker
            continue
        if not cur:
            continue
        # "ANSWER:" / "ANSWER Y)" / "Answer:"; a wrapped stem line starting "answer in ..." is not one
        am = re.match(r"^\s*(?:ANSWERS?\s*:?|[Aa]nswers?\s*:)\s*(?=\S)", plain)
        if am and cur["state"] == "q":
            cur["state"] = "a"
            cur["ans"].append(r["text"][len(am.group(0)):] if r["text"].startswith(plain[:len(am.group(0))]) else plain[len(am.group(0)):])
            cur["regions"]["a"].append((pno, r))
        elif cur["state"] == "a":
            if re.match(r"^\s*\d+\s*\)", plain):  # stray next-question line without marker
                cur = None
                continue
            cur["ans"].append(r["text"])
            cur["regions"]["a"].append((pno, r))
        else:
            cur["lines"].append(r["text"])
            cur["regions"]["q"].append((pno, r))
        st = cur["state"] if cur else None
        if cur and (r.get("img") or "CambriaMath" in r["fonts"]):
            cur["flag"][st] = 2
        elif cur and st == "q" and is_math_row(r["text"]) and len(cur["lines"]) > 1:
            cur["flag"][st] = max(cur["flag"][st], 1)

    out = []
    for q in questions:
        if not q["ans"]:
            continue
        stem, choices = [], []
        for ln in q["lines"]:
            cm = CHOICE_RE.match(re.sub(r"[\x01-\x04]", "", ln))
            if q["format"] == "mc" and cm and len(choices) == "WXYZ".index(cm.group(1)):
                choices.append(ln[ln.index(")") + 1:])
            elif choices:
                choices[-1] += " " + ln
            else:
                stem.append(ln)
        text, g1 = degarble(norm_space(to_latex(" ".join(stem))))
        choices = [degarble(norm_space(to_latex(c))) for c in choices]
        g2 = any(g for _, g in choices)
        choices = [norm_space(c) for c, _ in choices]
        answer, g3 = degarble(norm_space(to_latex(" ".join(q["ans"]))))
        text, answer = norm_space(text), norm_space(answer)
        if g1 or g2:
            q["flag"]["q"] = 2
        if g3:
            q["flag"]["a"] = 2
        if q["format"] == "mc" and len(choices) != 4:
            # couldn't split choices; keep everything as text
            text = norm_space(to_latex(" ".join(q["lines"])))
            choices = []
        rec = {"set": set_no, "round": round_name, "num": q["num"], "part": q["part"],
               "category": q["category"], "format": q["format"], "text": text, "answer": answer}
        if q["sub"]:
            rec["sub"] = q["sub"]
        if choices:
            rec["choices"] = choices
        for key in ("q", "a"):
            if q["flag"][key] and q["regions"][key]:
                rec["img_" + key] = crop(doc, q["regions"][key], img_dir, set_no, round_name, q, key, q["regions"]["a"][0])
                if q["flag"][key] == 1:
                    rec["img_" + key + "_optional"] = True
        out.append(rec)
    return out


def crop(doc, regions, img_dir, set_no, round_name, q, key, ans_row):
    by_page = collections.OrderedDict()
    for pno, r in regions:
        rect = fitz.Rect(r["x0"], r["y0"], r["x1"], r["y1"])
        by_page[pno] = by_page[pno] | rect if pno in by_page else rect
    names = []
    for i, (pno, rect) in enumerate(by_page.items()):
        page = doc[pno]
        rect = fitz.Rect(max(rect.x0 - 6, 0), rect.y0 - 6, min(rect.x1 + 6, page.rect.width), rect.y1 + 6)
        apage, arow = ans_row
        if pno == apage:
            # stacked answer fractions start above the ANSWER baseline
            if key == "q":
                rect.y1 = min(rect.y1, arow["y0"] - 9)
            else:
                rect.y0 = min(rect.y0, arow["y0"] - 12)
        pix = page.get_pixmap(clip=rect, matrix=fitz.Matrix(2.5, 2.5), colorspace=fitz.csGRAY)
        rtag = re.sub(r"\W", "", round_name)
        name = f"s{set_no}-r{rtag}-{q['part'][0]}{q['num']}-{key}{i}.png"
        pix.save(os.path.join(img_dir, name))
        names.append(name)
    return names


def main():
    pdf_dir, names_path = sys.argv[1], sys.argv[2]
    link_names = json.load(open(names_path))
    names = {k.split("/")[-2] + "__" + k.split("/")[-1]: v for k, v in link_names.items()}
    # crops of image/equation-font math, for transcribing into data/overrides.json (not shipped)
    img_dir = os.path.join(pdf_dir, "crops")
    os.makedirs(img_dir, exist_ok=True)
    for f in glob.glob(os.path.join(img_dir, "*.png")):
        os.remove(f)
    allq, report = [], []
    files = sorted(glob.glob(os.path.join(pdf_dir, "*.pdf")))
    for f in files:
        base = os.path.basename(f)
        set_no = int(re.search(r"Sample-Set-(\d+)", base).group(1))
        rname = names.get(base, base)
        rname = "Energy" if rname == "Sample Energy Questions" else rname.replace("Round ", "")
        qs = parse_pdf(f, set_no, rname, img_dir)
        report.append((base, sum(q["part"] == "tossup" for q in qs), sum(q["part"] == "bonus" for q in qs)))
        allq.extend(qs)
    allq.sort(key=lambda q: (q["set"], int(q["round"]) if q["round"].isdigit() else 99, q["num"], q["part"] != "tossup"))
    for i, q in enumerate(allq):
        q["id"] = f"{q['set']}-{q['round']}-{q['num']}{q['part'][0]}"
    # hand-checked LaTeX transcriptions of questions whose math was images in the PDF
    overrides = json.load(open(os.path.join(OUT, "overrides.json")))
    unreviewed = []
    for q in allq:
        o = overrides.get(q["id"])
        if o:
            q["text"], q["answer"] = o["text"], o["answer"]
            if o.get("choices"):
                q["choices"] = o["choices"]
                if re.match(r"^[WXYZ]\)", q["answer"]):
                    q["format"] = "mc"
        elif "img_q" in q or "img_a" in q:
            unreviewed.append(q["id"])
        for k in [k for k in q if k.startswith("img_")]:
            del q[k]
    if unreviewed:
        print(len(unreviewed), "questions have image math but no override; crops are in", img_dir)
    json.dump(allq, open(os.path.join(OUT, "questions.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    sources = {}
    for path, name in link_names.items():
        if name.startswith("Round "):
            set_no = int(re.search(r"Sample-Set-(\d+)", path).group(1))
            sources[f"{set_no}-{name[6:]}"] = "https://science.osti.gov" + path
    json.dump(sources, open(os.path.join(OUT, "sources.json"), "w"), indent=0)
    for r in report:
        if r[1] < 15 or r[2] < 15:
            print("LOW", *r)
    print(len(allq), "questions")


if __name__ == "__main__":
    main()
