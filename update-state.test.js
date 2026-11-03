const test = require('node:test'), assert = require('node:assert/strict');
const { braveReapplyState: state } = require('./renderer/update-state');
test('upgrading a legacy patched install requests game reapplication', () => {
  assert.equal(state({patched:true}, 'C:/Game', '1.3.1', {}).needsReapply, true);
});
test('an unpatched game uses initial apply, not an upgrade banner', () => {
  assert.equal(state({patched:false}, 'C:/Game', '1.3.1', {}).needsReapply, false);
});
test('successful application clears the banner only for that game and version', () => {
  const saved = {'c:/game':'1.3.1'};
  assert.equal(state({patched:true}, 'C:/GAME', '1.3.1', saved).needsReapply, false);
  assert.equal(state({patched:true}, 'D:/Game', '1.3.1', saved).needsReapply, true);
  assert.equal(state({patched:true}, 'C:/Game', '1.3.2', saved).needsReapply, true);
});
test('a Steam update still requests reapplication at the same app version', () => {
  assert.equal(state({patched:true,needs_reapply:true}, 'C:/Game', '1.3.1', {'c:/game':'1.3.1'}).needsReapply, true);
});
