export class Timings {
    values = {};
    record(name, milliseconds) {
        const value = this.values[name] ??= { count: 0, total_ms: 0, max_ms: 0 };
        value.count++;
        value.total_ms += milliseconds;
        value.max_ms = Math.max(value.max_ms, milliseconds);
    }
    snapshot() {
        return Object.fromEntries(Object.entries(this.values).map(([name, value]) => [name, { ...value }]));
    }
}
export function timingDifference(after, before) {
    return Object.fromEntries(Object.entries(after).map(([name, value]) => [name, { count: value.count - (before[name]?.count ?? 0), total_ms: value.total_ms - (before[name]?.total_ms ?? 0) }]).filter(([, value]) => value.count > 0));
}
