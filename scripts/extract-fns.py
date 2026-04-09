import re, sys

def build_index(path):
    with open(path) as f:
        lines = f.readlines()
    starts = []
    for i, line in enumerate(lines):
        if re.match(r'^(async function|function) ', line):
            name = line.split('(')[0].replace('async function ', '').replace('function ', '').strip()
            starts.append((i, name))
    ranges = {}
    for idx, (s, name) in enumerate(starts):
        e = starts[idx+1][0] - 1 if idx + 1 < len(starts) else len(lines) - 1
        ranges[name] = (s, e)
    return lines, ranges

def extract(path, names, out_path, imports):
    lines, ranges = build_index(path)
    blocks = []
    for n in names:
        if n not in ranges:
            print(f"WARN: {n} not found", file=sys.stderr)
            continue
        s, e = ranges[n]
        blocks.append((s, e, ''.join(lines[s:e+1])))
    blocks.sort(key=lambda x: x[0])
    with open(out_path, 'w') as f:
        f.write(imports + '\n')
        for _, _, text in blocks:
            f.write(text)
            if not text.endswith('\n'):
                f.write('\n')
    # print deleted ranges for sed
    all_ranges = sorted((ranges[n] for n in names if n in ranges), key=lambda x: x[0])
    merged = []
    for s, e in all_ranges:
        if merged and s <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    for s, e in merged:
        print(f"{s+1},{e+1}d")

if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "list":
        _, ranges = build_index(sys.argv[2])
        for n, (s, e) in sorted(ranges.items(), key=lambda x: x[1][0]):
            print(f"{s+1:5d}-{e+1:5d} {n}")
    elif mode == "extract":
        src = sys.argv[2]
        names = sys.argv[3].split(',')
        out = sys.argv[4]
        imports = sys.argv[5] if len(sys.argv) > 5 else ""
        extract(src, names, out, imports)
