// Built-in (C++) effects whose Audacity-3.7.8 modal checks depend on the
// selection or on source sample rates, which GetInfo does not report.
import type { TrackInfo } from '../ops.js';
import type { Parameters } from './parameters.js';

export const NATIVE_CONTEXT = new Set([
  'ClassicFilters',
  'FilterCurve',
  'GraphicEq',
  'Paulstretch',
  'Echo',
  'TruncateSilence',
]);

export interface NativeTrack {
  track: TrackInfo;
  index: number;
}

/** PaulstretchBase::GetBufferSize (PaulstretchBase.cpp:353-369), float steps included; 0 means overflow. */
export function paulstretchBuffer(rate: number, resolution: number): number {
  const half = Math.fround((rate * Math.fround(resolution)) / 2);
  const size = Math.fround(2 ** Math.floor(Math.fround(Math.log(half) / Math.log(2)) + 0.5));
  return Number.isSafeInteger(size) && size > 0 ? Math.max(size, 128) : 0;
}

/** Refuse settings that reach a native message box; `rate` measures a track's source rate. */
export async function preflightNativeEffect(
  id: string,
  params: Parameters,
  time: { start: number; end: number },
  selected: NativeTrack[],
  rate: (selection: NativeTrack) => Promise<number>,
): Promise<void> {
  if (id === 'TruncateSilence') {
    // TruncSilenceBase.cpp:232-253: independent truncation refuses two selected
    // audio tracks in one sync-lock group; one selected track always passes.
    if (params.Independent === true && selected.length > 1)
      throw new Error('TruncateSilence Independent=true processes one selected audio track at a time');
  } else if (id === 'Echo') {
    // EchoBase.cpp:64-79 truncates source rate x Delay to its history length and
    // reports a failed allocation in a dialog; zero samples are then written out of
    // bounds (:100-107). A longer delay than the selection adds no echo.
    const delay = Number(params.Delay ?? 1);
    if (delay > time.end - time.start) throw new Error('Echo Delay must not exceed the selected duration');
    for (const selection of selected) {
      const samples = Math.trunc((await rate(selection)) * delay);
      if (samples < 1 || samples > 16_777_216)
        throw new Error(
          `Echo Delay=${delay} s is ${samples} samples on track ${selection.index}; it needs 1 to 16777216 (64 MiB)`,
        );
    }
  } else if (id === 'Paulstretch') {
    // PaulstretchBase.cpp:192-262: each track's selected audio must hold two
    // buffers plus one sample, or a "Time Resolution is too long" dialog opens.
    // One more sample absorbs native selection quantization.
    for (const selection of selected) {
      const start = Math.max(time.start, selection.track.start);
      const end = Math.min(time.end, selection.track.end);
      if (!(end > start)) continue;
      const hz = await rate(selection);
      const buffer = paulstretchBuffer(hz, Number(params['Time Resolution'] ?? 0.25));
      const samples = Math.floor(end * hz + 0.5) - Math.floor(start * hz + 0.5);
      if (!buffer || samples < 2 * buffer + 2)
        throw new Error(
          `Paulstretch Time Resolution is too long for the ${(end - start).toFixed(3)} s selected on track ${selection.index}; select more audio or shorten it`,
        );
    }
  } else if (id !== 'ClassicFilters' || selected.length > 1) {
    // EqualizationBase.cpp:254-297 and ScienFilterBase.cpp:159-183 open a dialog
    // for selected tracks of different rates; equalization also at 40 Hz or less.
    const rates = [];
    for (const selection of selected) rates.push(await rate(selection));
    if (new Set(rates).size > 1)
      throw new Error(`${id} needs all selected audio tracks at one source sample rate; found ${rates.join(', ')} Hz`);
    if (id !== 'ClassicFilters' && rates.some((hz) => hz / 2 <= 20))
      throw new Error(`${id} needs a source sample rate above 40 Hz`);
  }
}
