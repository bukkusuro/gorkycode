import { type Entry, minutes } from './calendar.js';

export function layoutEvents(entries: Entry[], start: number, end: number, minimumHeight = 88) {
  const scale = 1.5;
  const placed = entries
    .map((e) => {
      const time = minutes(e.time);
      const a = Math.max(time, start),
        b = Math.min(time + e.duration, end);
      return {
        e,
        a,
        b,
        top: (a - start) * scale,
        height: Math.max(minimumHeight, (b - a) * scale),
        lane: 0,
        lanes: 1,
        group: 0,
      };
    })
    .filter((v) => (v.e.atTime ? minutes(v.e.time) >= start && minutes(v.e.time) < end : v.b > v.a))
    .sort((a, b) => a.a - b.a || b.b - a.b || a.e.id.localeCompare(b.e.id));
  const laneEnds: number[] = [],
    laneCounts: number[] = [];
  let group = -1,
    groupEnd = -1;
  for (const v of placed) {
    if (v.top >= groupEnd) {
      group++;
      laneEnds.length = 0;
      groupEnd = -1;
    }
    let lane = laneEnds.findIndex((end) => end <= v.top);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = v.top + v.height;
    groupEnd = Math.max(groupEnd, laneEnds[lane]);
    laneCounts[group] = laneEnds.length;
    v.lane = lane;
    v.group = group;
  }
  for (const v of placed) v.lanes = laneCounts[v.group];
  return placed;
}

export function selectMonth(date: Date, year: number, month: number) {
  return new Date(
    year,
    month,
    Math.min(date.getDate(), new Date(year, month + 1, 0).getDate()),
    12,
  );
}

export function compactLayout(layout: ReturnType<typeof layoutEvents>) {
  const visible: typeof layout = [];
  const overflow = new Map<number, { group: number; top: number; count: number }>();
  for (const item of layout) {
    if (item.lanes <= 3 || item.lane < 2) {
      visible.push(item);
      continue;
    }
    const group = overflow.get(item.group);
    if (group) {
      group.count++;
      group.top = Math.min(group.top, item.top);
    } else overflow.set(item.group, { group: item.group, top: item.top, count: 1 });
  }
  return { visible, overflow: [...overflow.values()] };
}

export function countSimultaneous(entries: Entry[]) {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.allDay) counts.set(entry.time, (counts.get(entry.time) || 0) + 1);
  }
  let total = 0;
  for (const count of counts.values()) if (count > 1) total += count;
  return total;
}
