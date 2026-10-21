export type TimingValue = {
    count: number;
    total_ms: number;
    max_ms: number;
};
export type TimingSnapshot = Record<string, TimingValue>;
export declare class Timings {
    private readonly values;
    record(name: string, milliseconds: number): void;
    snapshot(): TimingSnapshot;
}
export declare function timingDifference(after: TimingSnapshot, before: TimingSnapshot): Record<string, {
    count: number;
    total_ms: number;
}>;
