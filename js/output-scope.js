// output-scope.js
//
// Pure decisions about which lo-fi processing is eligible for a given task, and whether Export
// should write a secondary "clean" (unprocessed) copy alongside the primary output. Kept separate
// from outputstage.js (the actual DSP - it has no notion of "task") and from app.js (DOM/settings
// orchestration) so both halves of the CHOP-gets-Output-Stage feature can be unit-tested without a
// browser or a decoded file.
//
// CHOP shares the Output Stage character (tape/vinyl/etc.) with STRETCH/BOTH, but deliberately not
// Drive or Crunch - CHOP's settings rail only exposes the Output Stage control (see index.html), so
// a Drive/Crunch setting left on from a BOTH session must not silently colour a CHOP export via a
// control CHOP never shows. isLofiActive()/lofiSnapshotForTask() enforce that same "only Output
// Stage" cutoff wherever the settings actually reach the audio.

/**
 * @param {"chop"|"stretch"|"both"} task
 * @param {{enabled:boolean}} outputStage
 * @param {{enabled:boolean}} drive
 * @param {{enabled:boolean}} crunch
 * @returns {boolean} true if any lo-fi stage eligible for this task is switched on
 */
export function isLofiActive(task, outputStage, drive, crunch) {
  if (task === "chop") return !!outputStage.enabled;
  return !!(outputStage.enabled || drive.enabled || crunch.enabled);
}

/**
 * Plain snapshot of the lo-fi settings actually eligible for `task`, safe to structured-clone into a
 * worker message - drive/crunch forced off for CHOP regardless of their own `enabled` flag, so a
 * worker asked to render a CHOP chop can never apply a stage CHOP has no control for.
 */
export function lofiSnapshotForTask(task, outputStage, drive, crunch) {
  if (task === "chop") {
    return { outputStage: { ...outputStage }, drive: { ...drive, enabled: false }, crunch: { ...crunch, enabled: false } };
  }
  return { outputStage: { ...outputStage }, drive: { ...drive }, crunch: { ...crunch } };
}

/**
 * Whether Export should also write an unprocessed "clean" copy alongside the primary output.
 *
 * OUTPUT STAGE OFF (processingActive false) -> clean IS already the primary output; never a
 * secondary copy, regardless of what the "also export clean" checkbox says.
 * OUTPUT STAGE ON (processingActive true) -> processed is primary; a secondary clean copy is
 * written only if alsoExportClean is also checked.
 */
export function wantsCleanSecondary(processingActive, alsoExportClean) {
  return !!(processingActive && alsoExportClean);
}
