import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactLayout,
  countSimultaneous,
  layoutEvents,
  selectMonth,
} from '../.tools/test-build/eventLayout.js';
import { validEntry } from '../.tools/test-build/calendar.js';
import { segment, standardAppearance, defaults } from '../.tools/test-build/model.js';
const entry = (id, time, duration = 60) => ({
  id,
  title: id,
  type: 'task',
  date: '2026-10-16',
  time,
  duration,
  color: '#123abc',
  important: true,
  description: 'Comment',
});
test('5-minute event at 23:55 stays clickable inside bottom gutter, real time unchanged', () => {
  const e = entry('late', '23:55', 5),
    [v] = layoutEvents([e], 0, 1440);
  assert.ok(validEntry(e));
  assert.equal(v.top, 1435 * 1.5);
  assert.equal(v.height, 88);
  assert.ok(v.top + v.height <= 1440 * 1.5 + 88);
  assert.equal(e.duration, 5);
  assert.equal(e.time, '23:55');
});
for (const count of [2, 3, 5])
  test(`${count} simultaneous events get separate equal columns`, () => {
    const result = layoutEvents(
      Array.from({ length: count }, (_, i) => entry(String(i), '10:00')),
      0,
      1440,
    );
    assert.equal(new Set(result.map((v) => v.lane)).size, count);
    assert.ok(result.every((v) => v.lanes === count));
  });
test('5, 10, 15 and 20 minute events keep their duration and readable height', () => {
  for (const duration of [5, 10, 15, 20]) {
    const e = entry('short', '10:00', duration),
      [v] = layoutEvents([e], 0, 1440);
    assert.ok(v.height >= 88);
    assert.equal(e.duration, duration);
  }
});
test('partial, nested and visually expanded short events never intersect in same lane', () => {
  const result = layoutEvents(
    [
      entry('a', '09:00', 180),
      entry('b', '09:15'),
      entry('c', '10:00', 5),
      entry('d', '10:10', 10),
      entry('e', '12:00'),
    ],
    0,
    1440,
  );
  for (const a of result)
    for (const b of result)
      if (a !== b && a.group === b.group && a.lane === b.lane)
        assert.ok(a.top + a.height <= b.top || b.top + b.height <= a.top);
});
test('touching intervals reuse column, midnight splits and bounds clip safely', () => {
  assert.ok(
    layoutEvents([entry('a', '09:00'), entry('b', '10:00')], 0, 1440).every((v) => v.lanes === 1),
  );
  const e = entry('night', '23:55', 20);
  assert.equal(segment(e, '2026-10-17').duration, 15);
  assert.equal(layoutEvents([segment(e, '2026-10-17')], 0, 1440)[0].top, 0);
  assert.equal(layoutEvents([entry('early', '00:00')], 480, 1200).length, 0);
});
test('month choice clamps date including leap years', () => {
  assert.equal(selectMonth(new Date(2026, 0, 31), 2026, 1).getDate(), 28);
  assert.equal(selectMonth(new Date(2026, 0, 31), 2028, 1).getDate(), 29);
});
test('standard theme resets only appearance', () => {
  const p = {
    ...defaults,
    theme: 'dark',
    accent: '#ff22aa',
    text: 'large',
    density: 'full',
    zone: 'Asia/Tokyo',
    taskColor: '#123abc',
    hourStart: 5,
    lead: 60,
  };
  const next = standardAppearance(p);
  assert.deepEqual(next, {
    ...p,
    theme: 'system',
    accent: '#805039',
    text: 'medium',
    density: 'standard',
  });
  assert.equal(p.theme, 'dark');
});
test('dense display preserves every record through visible cards and group counters', () => {
  for (const count of [1, 2, 3, 4, 20, 100]) {
    const entries = Array.from({ length: count }, (_, i) => entry(String(i), '10:00'));
    const { visible, overflow } = compactLayout(layoutEvents(entries, 0, 1440));
    assert.equal(visible.length + overflow.reduce((sum, group) => sum + group.count, 0), count);
    assert.equal(visible.length, count > 3 ? 2 : count);
    assert.ok(visible.every((item) => item.e.time === '10:00' && item.e.duration === 60));
  }
  const entries = [
    '09:00',
    '09:00',
    '09:00',
    '09:00',
    '12:00',
    '12:00',
    '12:00',
    '12:00',
    '15:00',
  ].map((time, i) => entry(String(i), time));
  const { overflow } = compactLayout(layoutEvents(entries, 0, 1440));
  assert.equal(overflow.length, 2);
  assert.ok(overflow[0].top < overflow[1].top);
  assert.equal(countSimultaneous(entries), 8);
  assert.equal(countSimultaneous([{ ...entries[0], allDay: true }, entries[1]]), 0);
});
