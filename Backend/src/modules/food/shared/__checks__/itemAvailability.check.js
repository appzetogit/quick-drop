/**
 * Self-check for per-item availability windows.
 * Run: node src/modules/food/shared/__checks__/itemAvailability.check.js
 */
import assert from 'node:assert/strict';
import {
    DAY_NAMES,
    describeTodaysWindow,
    getZonedDayAndMinutes,
    isItemAvailableAt,
    normalizeAvailabilityScheduleInput,
    normalizeTimeOfDay
} from '../itemAvailability.js';

const throws = (fn) => assert.throws(fn, { name: 'ValidationError' });

/** Build a schedule where only `day` is on, for `start`-`end`. */
const only = (day, start, end, extra = {}) => ({
    isEnabled: true,
    timezone: 'Asia/Kolkata',
    days: DAY_NAMES.map((d) => ({
        day: d,
        isAvailable: d === day,
        startTime: d === day ? start : '09:00',
        endTime: d === day ? end : '22:00'
    })),
    ...extra
});

/** A UTC instant for a given IST wall-clock time. IST is UTC+5:30, no DST. */
const ist = (iso) => new Date(`${iso}+05:30`);

// --- time parsing ---------------------------------------------------------
assert.equal(normalizeTimeOfDay('9:05'), '09:05');
assert.equal(normalizeTimeOfDay('23:59'), '23:59');
assert.equal(normalizeTimeOfDay('24:00', null), null);
assert.equal(normalizeTimeOfDay('12:60', null), null);
assert.equal(normalizeTimeOfDay('', 'x'), 'x');
assert.equal(normalizeTimeOfDay(null, 'x'), 'x');

// --- timezone: the whole reason this helper exists ------------------------
// 2026-08-24 is a Monday. 05:00 UTC is 10:30 IST the same day.
{
    const z = getZonedDayAndMinutes(new Date('2026-08-24T05:00:00Z'), 'Asia/Kolkata');
    assert.equal(z.day, 'Monday');
    assert.equal(z.minutes, 10 * 60 + 30);
}
// 20:00 UTC Monday is already 01:30 IST on Tuesday -- the case a UTC-naive
// implementation gets wrong.
{
    const z = getZonedDayAndMinutes(new Date('2026-08-24T20:00:00Z'), 'Asia/Kolkata');
    assert.equal(z.day, 'Tuesday');
    assert.equal(z.minutes, 90);
}
// An unknown zone must not throw; it falls back to IST.
assert.equal(getZonedDayAndMinutes(new Date('2026-08-24T05:00:00Z'), 'Not/AZone').day, 'Monday');

// --- disabled or absent means always available ----------------------------
assert.equal(isItemAvailableAt(undefined), true);
assert.equal(isItemAvailableAt(null), true);
assert.equal(isItemAvailableAt({ isEnabled: false, days: [] }), true);
// Enabled but with no day entries is treated as unrestricted rather than hiding.
assert.equal(isItemAvailableAt({ isEnabled: true, days: [] }), true);

// --- a normal daytime window ---------------------------------------------
{
    const breakfast = only('Monday', '08:00', '11:30');
    assert.equal(isItemAvailableAt(breakfast, ist('2026-08-24T08:00:00')), true);  // at open
    assert.equal(isItemAvailableAt(breakfast, ist('2026-08-24T10:00:00')), true);  // inside
    assert.equal(isItemAvailableAt(breakfast, ist('2026-08-24T07:59:00')), false); // before
    assert.equal(isItemAvailableAt(breakfast, ist('2026-08-24T11:30:00')), false); // end exclusive
    assert.equal(isItemAvailableAt(breakfast, ist('2026-08-25T10:00:00')), false); // Tuesday off
}

// --- overnight window: the case that breaks naive comparisons -------------
{
    const lateNight = only('Friday', '22:00', '02:00');
    // 2026-08-28 is a Friday.
    assert.equal(isItemAvailableAt(lateNight, ist('2026-08-28T22:00:00')), true);  // opens Friday
    assert.equal(isItemAvailableAt(lateNight, ist('2026-08-28T23:30:00')), true);  // before midnight
    assert.equal(isItemAvailableAt(lateNight, ist('2026-08-29T01:00:00')), true);  // Saturday tail
    assert.equal(isItemAvailableAt(lateNight, ist('2026-08-29T02:00:00')), false); // tail ended
    assert.equal(isItemAvailableAt(lateNight, ist('2026-08-28T21:59:00')), false); // before open
    // Saturday evening must NOT be covered: Saturday's own entry is off, and
    // Friday's window only lends its post-midnight tail.
    assert.equal(isItemAvailableAt(lateNight, ist('2026-08-29T23:00:00')), false);
}

// --- a window that wraps into a day which is itself enabled ---------------
{
    const everyDayLate = {
        isEnabled: true,
        timezone: 'Asia/Kolkata',
        days: DAY_NAMES.map((d) => ({ day: d, isAvailable: true, startTime: '18:00', endTime: '01:00' }))
    };
    assert.equal(isItemAvailableAt(everyDayLate, ist('2026-08-24T19:00:00')), true);
    assert.equal(isItemAvailableAt(everyDayLate, ist('2026-08-25T00:30:00')), true);  // yesterday's tail
    assert.equal(isItemAvailableAt(everyDayLate, ist('2026-08-25T02:00:00')), false); // gap
}

// --- start === end is treated as all day ----------------------------------
assert.equal(isItemAvailableAt(only('Monday', '00:00', '00:00'), ist('2026-08-24T13:00:00')), true);

// --- normalization --------------------------------------------------------
assert.equal(normalizeAvailabilityScheduleInput(undefined), undefined); // untouched on partial update
assert.deepEqual(normalizeAvailabilityScheduleInput(null).isEnabled, false);
{
    const n = normalizeAvailabilityScheduleInput({ isEnabled: true, days: [{ day: 'Mon', startTime: '8:00', endTime: '11:30' }] });
    assert.equal(n.isEnabled, true);
    assert.equal(n.days.length, 7);
    assert.equal(n.timezone, 'Asia/Kolkata');
    const mon = n.days.find((d) => d.day === 'Monday');
    assert.equal(mon.startTime, '08:00'); // padded
    assert.equal(mon.endTime, '11:30');
    // Days the caller omitted default to available with the default window.
    assert.equal(n.days.find((d) => d.day === 'Sunday').isAvailable, true);
}
{
    // The keyed form the outlet-timings screen already uses.
    const n = normalizeAvailabilityScheduleInput({
        isEnabled: true,
        days: { Monday: { isAvailable: true, startTime: '07:00', endTime: '10:00' } }
    });
    assert.equal(n.days.find((d) => d.day === 'Monday').startTime, '07:00');
}
// Garbage times fall back rather than storing something unparseable.
{
    const n = normalizeAvailabilityScheduleInput({ isEnabled: true, days: [{ day: 'Monday', startTime: 'nonsense', endTime: '99:99' }] });
    const mon = n.days.find((d) => d.day === 'Monday');
    assert.equal(mon.startTime, '09:00');
    assert.equal(mon.endTime, '22:00');
}
// An unknown timezone falls back rather than being stored and failing later.
assert.equal(normalizeAvailabilityScheduleInput({ isEnabled: true, timezone: 'Not/AZone' }).timezone, 'Asia/Kolkata');

throws(() => normalizeAvailabilityScheduleInput('nope'));
throws(() => normalizeAvailabilityScheduleInput([1, 2]));
// Enabled with every day off would hide the item forever.
throws(() => normalizeAvailabilityScheduleInput({
    isEnabled: true,
    days: DAY_NAMES.map((d) => ({ day: d, isAvailable: false }))
}));
// The same shape is fine while disabled.
assert.equal(
    normalizeAvailabilityScheduleInput({ isEnabled: false, days: DAY_NAMES.map((d) => ({ day: d, isAvailable: false })) }).isEnabled,
    false
);

// --- refusal message ------------------------------------------------------
assert.match(describeTodaysWindow(only('Monday', '08:00', '11:30'), ist('2026-08-24T13:00:00')), /08:00-11:30 on Monday/);
assert.match(describeTodaysWindow(only('Monday', '08:00', '11:30'), ist('2026-08-25T13:00:00')), /not available on Tuesday/);
assert.equal(describeTodaysWindow(null), '');

console.log('All item-availability checks passed.');
