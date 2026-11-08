#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# prints every region where two sbf binaries of the same size differ: offset, span length, elf section, number of
# differing bytes, and the old and new bytes of the span in hex.
# a region is a run of differing bytes in which each differing byte is at most 16 bytes after the previous one.
# usage: python3 diff-regions.py [old.so] [new.so]   (defaults: bins/old_live.so bins/new_verified.so next to this file)
import struct
import sys
from pathlib import Path

GAP = 16
here = Path(__file__).resolve().parent
old_path = Path(sys.argv[1]) if len(sys.argv) > 1 else here / 'bins' / 'old_live.so'
new_path = Path(sys.argv[2]) if len(sys.argv) > 2 else here / 'bins' / 'new_verified.so'
old = old_path.read_bytes()
new = new_path.read_bytes()
if len(old) != len(new):
    sys.exit(f'sizes differ: {len(old)} and {len(new)}; this script compares same-size binaries only')


def sections(elf):
    shoff = struct.unpack_from('<Q', elf, 0x28)[0]
    shentsize, shnum, shstrndx = struct.unpack_from('<HHH', elf, 0x3A)
    headers = [struct.unpack_from('<IIQQQQIIQQ', elf, shoff + k * shentsize) for k in range(shnum)]
    strtab = headers[shstrndx]
    names = elf[strtab[4]:strtab[4] + strtab[5]]
    out = []
    for h in headers:
        name = names[h[0]:names.index(b'\0', h[0])].decode()
        if h[5]:
            out.append((name, h[4], h[5]))
    return out


secs = sections(old)
if secs != sections(new):
    print('note: section headers differ between the two files')


def section_of(offset):
    for name, start, size in secs:
        if start <= offset < start + size:
            return name
    return '(outside sections)'


diff = [i for i in range(len(old)) if old[i] != new[i]]
regions = []
if diff:
    start = prev = diff[0]
    count = 1
    for i in diff[1:]:
        if i - prev > GAP:
            regions.append((start, prev, count))
            start, count = i, 0
        prev = i
        count += 1
    regions.append((start, prev, count))

print(f'old {old_path.name} {len(old)} bytes, new {new_path.name} {len(new)} bytes')
print(f'differing bytes: {len(diff)}, regions: {len(regions)}')
per_section = {}
for i in diff:
    per_section[section_of(i)] = per_section.get(section_of(i), 0) + 1
print('differing bytes per section: ' + ', '.join(f'{k} {v}' for k, v in per_section.items()))
for n, (start, end, count) in enumerate(regions, 1):
    span = end - start + 1
    print(f'\n#{n} offset {start} (0x{start:x}) length {span} section {section_of(start)} differing {count}')
    print(f'  old {old[start:end + 1].hex()}')
    print(f'  new {new[start:end + 1].hex()}')
