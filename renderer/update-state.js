/* Shared with release tests: an app update does not itself patch the game. */
function braveReapplyState(status, gamePath, version, appliedVersions) {
  const gameUpdated = !!status.needs_reapply;
  const toolUpdated = !!(status.patched && version && appliedVersions?.[gamePath.toLowerCase()] !== version);
  return {
    needsReapply: gameUpdated || toolUpdated,
    title: gameUpdated ? 'تحديث جديد للعبة' : 'تحديث الأداة جاهز للعبة',
    reason: gameUpdated ? 'ملفاتها تغيّرت، طبّق التحسينات من جديد.' : 'أغلق اللعبة واضغط «طبّق الآن» لتفعيل تحسينات الإصدار الجديد.',
  };
}
if (typeof module !== 'undefined') module.exports = { braveReapplyState };
