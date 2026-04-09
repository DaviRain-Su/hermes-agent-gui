import sys
ranges = []
for p in sys.argv[2:]:
    with open(p) as f:
        for line in f:
            line=line.strip()
            if not line or line.endswith('d'):
                line=line.rstrip('d')
            if ',' in line:
                a,b=line.split(',')
                ranges.append((int(a), int(b)))
ranges.sort()
merged=[]
for s,e in ranges:
    if merged and s<=merged[-1][1]+1:
        merged[-1]=(merged[-1][0], max(merged[-1][1], e))
    else:
        merged.append((s,e))
with open(sys.argv[1]) as f:
    lines=f.readlines()
remove=set()
for s,e in merged:
    for i in range(s-1, e):
        if i < len(lines):
            remove.add(i)
with open(sys.argv[1], 'w') as f:
    for i,line in enumerate(lines):
        if i not in remove:
            f.write(line)
print("Deleted ranges:", merged)
