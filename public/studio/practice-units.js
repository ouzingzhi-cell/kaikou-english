/**
 * A practice unit is one original speaker turn, not one punctuation sentence.
 * The fine sentence data remains untouched as evidence for the merged audio.
 */
export function getPracticeUnits(dialogue, rawSentences = [], audioInfo) {
  if (!Array.isArray(dialogue?.lines)) return [];
  const source = Array.isArray(rawSentences) ? rawSentences : [];
  const groups = dialogue.lines.map(() => []);
  let unassigned = false;
  source.forEach((sentence, index) => {
    if (Number.isInteger(sentence?.turnIndex) && groups[sentence.turnIndex]) {
      groups[sentence.turnIndex].push({ index, source: sentence, audio: audioInfo?.sentences?.[index] });
    } else {
      unassigned = true;
    }
  });
  const fullReady = audioInfo?.status === 'ready' && typeof audioInfo.url === 'string'
    && audioInfo.url.length > 0 && Number.isFinite(audioInfo.duration) && audioInfo.duration > 0;

  return dialogue.lines.map((line, turnIndex) => {
    const evidence = groups[turnIndex];
    const indices = evidence.map(member => member.index);
    const issues = [];
    if (unassigned) issues.push('unassigned-source-sentence');
    if (!evidence.length) issues.push('missing-source-sentences');
    if (evidence.map(member => member.source.en).join(' ') !== line.en) issues.push('turn-content-mismatch');
    if (evidence.some(member => member.source.speaker !== line.speaker)) issues.push('turn-speaker-mismatch');
    let previousEnd = -1;
    for (const member of evidence) {
      const span = member.audio;
      if (!span || span.status !== 'ready' || span.text !== member.source.en
        || !Number.isFinite(span.start) || !Number.isFinite(span.end)
        || span.start < 0 || span.end <= span.start || span.end > (audioInfo?.duration ?? 0) + .12) {
        issues.push('unverified-sentence-audio');
      } else if (span.start < previousEnd - .02) {
        issues.push('overlapping-sentence-audio');
      }
      previousEnd = span?.end ?? previousEnd;
    }

    const variations = (audioInfo?.sourceVariations || []).filter(item => indices.includes(item.sentenceIndex));
    const notes = [...new Set([
      ...evidence.map(member => member.audio?.note),
      ...variations.map(item => item.note),
    ].filter(note => typeof note === 'string' && note.trim()))];
    const unspokenSourceWords = [...new Set([
      ...evidence.flatMap(member => member.audio?.unspokenSourceWords || []),
      ...variations.flatMap(item => item.unspokenSourceWords || []),
    ])];
    const hasVariant = evidence.some(member => typeof member.audio?.audioTextVariant === 'string') || variations.length > 0;
    const spokenText = hasVariant ? evidence.map(member => {
      const variation = variations.find(item => item.sentenceIndex === member.index);
      return member.audio?.audioTextVariant || variation?.audioTextVariant || member.source.en;
    }).join(' ') : undefined;
    const ready = fullReady && issues.length === 0;
    const audio = {
      url: audioInfo?.url || null,
      start: ready ? Math.min(...evidence.map(member => member.audio.start)) : null,
      end: ready ? Math.max(...evidence.map(member => member.audio.end)) : null,
      status: ready ? 'ready' : audioInfo ? 'needs-review' : 'unavailable',
      note: notes.join(' '),
      notes,
      issues: [...new Set(issues)],
    };
    if (hasVariant) {
      audio.sourceVariation = true;
      audio.audioTextVariant = spokenText;
      audio.unspokenSourceWords = unspokenSourceWords;
    }
    return {
      ...line,
      id: `${dialogue.id}:turn:${turnIndex}`,
      index: turnIndex,
      turnIndex,
      sentenceIndices: indices,
      sentenceEvidence: evidence,
      audio,
      ...(notes.length ? { note: audio.note } : {}),
      ...(hasVariant ? { sourceVariation: true, audioTextVariant: spokenText, unspokenSourceWords } : {}),
    };
  });
}
