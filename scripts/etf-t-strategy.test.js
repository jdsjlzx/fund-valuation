const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/etf-t-strategy.js');
const base = { id: 1, date: '2026-11-05', side: 'buy', shares: 10000, price: 3 };
const sale = { id: 2, date: '2026-11-06', time: '10:35', side: 'sell', tAction: 'sell', shares: 2000, price: 2.9, fee: 5, tCap: 2000, tBase: 10000, tRules: { ...S.defaults } };
const fill = (overrides = {}) => ({ id: 3, date: sale.date, time: '11:05', side: 'buy', tAction: 'buy', tCycleId: '2', shares: 2000, price: 2.87, fee: 5, ...overrides });
const market = (overrides = {}) => ({ date: sale.date, live: true, tier: 'try', quote: { price: 2.87, premiumPct: 17, quoteTime: '2026-11-06 11:05' }, events: [{ time: '11:04', side: 'watch' }], ...overrides });

test('卖出额度固定20%，不能裸卖或突破真实持仓', () => {
  assert.equal(S.validateFill([base], sale), '');
  assert.match(S.validateFill([base], { ...sale, shares: 2100 }), /20%/);
  assert.match(S.validateFill([], sale), /持仓/);
  assert.match(S.validateFill([base], { ...sale, shares: 2001 }), /100/);
  assert.match(S.validateFill([base], { ...sale, tBase: 20000 }), /20%/);
});

test('同日只开一轮，前轮待接回不能新开', () => {
  assert.match(S.validateFill([base, sale], { ...sale, id: 4, time: '13:00' }), /未结束/);
  const closed = [base, sale, fill()];
  assert.match(S.validateFill(closed, { ...sale, id: 4, time: '11:30' }), /每天最多/);
});

test('实际费用进入持仓与配对净价差，不把卖出现金算利润', () => {
  const c = S.cycles([base, sale, fill()], 2.87)[0];
  assert.equal(c.pending, 0);
  assert.equal(c.held, 2000);
  assert.ok(Math.abs(c.pairedNet - 50) < 1e-8);
  assert.ok(Math.abs(c.relativeHolding - 50) < 1e-8);
  assert.ok(Math.abs(c.returnFloat + 5) < 1e-8);
  assert.ok(Math.abs(S.position([base, sale, fill()]).realized + 205) < 1e-8);
});

test('部分接回分摊卖出费用，未闭合不计算胜率', () => {
  const partial = fill({ shares: 1000 });
  const c = S.cycles([base, sale, partial], 2.87)[0];
  assert.equal(c.pending, 1000); assert.equal(c.held, 1000);
  assert.ok(Math.abs(c.pairedNet - 22.5) < 1e-8);
  assert.equal(S.evaluate([base, sale, partial], market()).stats.closed, 0);
  assert.match(S.validateFill([base, sale, partial], fill({ id: 4, shares: 1100 })), /超过本轮/);
});

test('接回上限覆盖实际卖出费、最低买入费、滑点与最低净价差', () => {
  const target = S.targetPrice(sale, sale.shares);
  const buyPrice = target + S.defaults.slippage;
  const cost = buyPrice * sale.shares + S.fee(buyPrice * sale.shares, S.defaults);
  assert.ok(cost <= (sale.price * sale.shares - sale.fee) * (1 - S.defaults.gap));
  assert.ok(target < sale.price * (1 - S.defaults.gap));
  assert.ok(S.targetPrice(sale, 100) < target);
});

test('高溢价与溢价缺失不阻止接回，仍需实时止跌与趋势风控', () => {
  assert.equal(S.evaluate([base, sale], market()).action, 'buy');
  for (const premium of [40, null, undefined, NaN]) {
    const m = market(); m.quote.premiumPct = premium;
    assert.equal(S.evaluate([base, sale], m).action, 'buy');
    assert.equal(S.evaluate([base, sale], { ...m, events: [] }).action, null);
    assert.equal(S.evaluate([base, sale], { ...m, live: false }).action, null);
    assert.equal(S.evaluate([base, sale], { ...m, tier: 'run' }).action, null);
    assert.equal(S.evaluate([base, sale], { ...m, tier: 'watch' }).action, null);
    assert.equal(S.evaluate([base, sale], { ...m, abort: true }).action, null);
  }
});

test('卖后上涨不追、14:30截止且不跨日接回', () => {
  const high = market(); high.quote.price = 3;
  const v = S.evaluate([base, sale], high);
  assert.equal(v.action, null); assert.equal(v.stats.flyCount, 1);
  const late = market(); late.quote.quoteTime = '2026-11-06 14:30';
  assert.equal(S.evaluate([base, sale], late).action, null);
  assert.equal(S.evaluate([base, sale], market({ date: '2026-11-09' })).action, null);
});

test('回补仓止损只退出实际接回份额，不卖掉底仓', () => {
  const trades = [base, sale, fill({ shares: 1000 })];
  const m = market(); m.quote.price = 2.84;
  assert.equal(S.evaluate(trades, m).action, 'exit');
  const exited = fill({ id: 4, time: '11:20', side: 'sell', tAction: 'exit', shares: 1000, price: 2.84 });
  assert.equal(S.validateFill(trades, exited), '');
  assert.match(S.validateFill(trades, { ...exited, shares: 1001 }), /退出不能超过/);
  const c = S.cycles([...trades, exited], 2.84)[0];
  assert.equal(c.held, 0); assert.equal(c.pending, 1000);
  assert.ok(Math.abs(c.exitPnl + 40) < 1e-8);
  assert.ok(Math.abs(c.relativeHolding - c.cash + 2000 * 2.84) < 1e-8);
});

test('其他普通买入已恢复仓位，做T不得额外叠加接回', () => {
  const ordinary = { id: 3, date: sale.date, time: '11:00', side: 'buy', price: 2.88, shares: 2000 };
  assert.match(S.validateFill([base, sale, ordinary], fill({ id: 4 })), /总持仓/);
  assert.equal(S.evaluate([base, sale, ordinary], market()).action, null);
});

test('所有实际成交记录允许亏损接回但必须如实统计亏损', () => {
  const expensive = fill({ price: 3 });
  assert.equal(S.validateFill([base, sale], expensive), '');
  assert.ok(S.cycles([base, sale, expensive], 3)[0].pairedNet < 0);
});

test('时间顺序、未来绑定、负费用和非整数份额不能破坏配对', () => {
  assert.match(S.validateFill([base, sale], fill({ time: '10:34' })), /找不到|早于/);
  assert.match(S.validateFill([base, sale], fill({ time: '12:00' })), /交易时段/);
  assert.match(S.validateFill([base, sale], fill({ fee: -1 })), /无效/);
  assert.match(S.validateFill([base, sale], fill({ shares: 0.5 })), /无效/);
  assert.match(S.validateFill([base, sale], fill({ side: 'sell' })), /方向/);
});

test('回放下一分钟成交，高溢价与溢价缺失不阻止接回', () => {
  const sample = (time, price, more = {}) => ({ date: sale.date, time, price, premium: 17, live: true, tier: 'try', ...more });
  const samples = [sample('10:34', 2.9, { sell: true }), sample('10:35', 2.89), sample('10:36', 2.865, { rebound: true }), sample('10:37', 2.86), sample('10:38', 2.86)];
  const r = S.replay(samples, 10000);
  assert.equal(r.trades[0].time, '10:35'); assert.ok(Math.abs(r.trades[0].price - 2.889) < 1e-10);
  assert.equal(r.trades[1].time, '10:37');
  assert.ok(r.pairedNet > 0);
  for (const premium of [40, null, undefined, NaN]) {
    assert.deepEqual(S.replay(samples.map(s => ({ ...s, premium })), 10000).trades, r.trades);
  }
});

test('回放断档不补造成交，尾部信号不从未来取价格', () => {
  const samples = [{ date: sale.date, time: '10:34', price: 2.9, premium: 17, live: true, sell: true }, { date: sale.date, time: '10:38', price: 2.8, premium: 17, live: true }];
  assert.equal(S.replay(samples, 10000).trades.length, 0);
  assert.equal(S.replay(samples.slice(0, 1), 10000).trades.length, 0);
});

test('补录更早的接回不得导致后续既有记录超过总卖出份额', () => {
  const trades = [base, sale, fill()];
  const backdated = fill({ id: 4, time: '11:00', shares: 1000 });
  assert.match(S.validateFill(trades, backdated), /后续已记录/);
});

test('参数改变不重写既有轮次接回参考和费用', () => {
  const oldTarget = S.cycles([base, sale], 2.8)[0].target;
  const evaluated = S.evaluate([base, sale], market(), { ...S.defaults, gap: 0.03, slippage: 0.01 });
  assert.equal(evaluated.cycles[0].target, oldTarget);
  assert.equal(evaluated.cycles[0].rules.gap, 0.006);
});

test('卖飞及回撤统计保留观測，接回后也不把回撤隐藏', () => {
  const marked = { ...sale, tFly: true, tMarks: [{ time: '10:36', delta: 10 }, { time: '10:40', delta: -30 }] };
  const v = S.evaluate([base, marked, fill()], market());
  assert.equal(v.stats.flyCount, 1);
  assert.equal(v.stats.drawdown, -40);
});

test('止损退出后不重新接回凑轮次，日后仍监控已接回仓位风险', () => {
  const partial = fill({ shares: 1000 });
  const exited = fill({ id: 4, time: '11:20', side: 'sell', tAction: 'exit', shares: 1000, price: 2.84 });
  const m = market(); m.quote.price = 2.8;
  assert.equal(S.evaluate([base, sale, partial, exited], m).action, null);
  const dayAfter = market({ date: '2026-11-09' }); dayAfter.quote.price = 2.8;
  assert.equal(S.evaluate([base, sale, partial], dayAfter).action, 'exit');
});

test('完整配对赚差价但止损亏损时，不统计成获胜轮次', () => {
  const returned = fill();
  const exited = fill({ id: 4, time: '11:20', side: 'sell', tAction: 'exit', price: 2.8 });
  const recovery = market(); recovery.quote.price = 2.9;
  const v = S.evaluate([base, sale, returned, exited], recovery);
  assert.ok(v.stats.pairedNet > 0);
  assert.ok(v.stats.exitPnl < 0);
  assert.equal(v.stats.wins, 0);
  assert.ok(v.stats.worstRound < 0);
});

test('百份低额度没有足够净价差时不会追买回，放弃轮次可继续记账', () => {
  const small = { ...sale, shares: 100, tAbandoned: true };
  const m = market(); m.quote.price = 2.89;
  assert.equal(S.evaluate([base, small], m).action, null);
  assert.equal(S.validateFill([base, small], fill({ shares: 100 })), '');
});

test('回放溢价缺失可接回，但信号与成交分钟均须通过趋势和失效风控', () => {
  const sample = (time, price, more = {}) => ({ date: sale.date, time, price, premium: 40, live: true, tier: 'try', ...more });
  const samples = [sample('10:34', 2.9, { sell: true }), sample('10:35', 2.89), sample('10:36', 2.865, { rebound: true }), sample('10:37', 2.86, { premium: null })];
  assert.equal(S.replay(samples, 10000).trades.filter(t => t.side === 'buy').length, 1);
  for (const index of [2, 3]) {
    for (const change of [{ tier: 'run' }, { tier: 'watch' }, { abort: true }, { live: false }]) {
      const blocked = samples.map((s, i) => i === index ? { ...s, ...change } : s);
      assert.equal(S.replay(blocked, 10000).trades.filter(t => t.side === 'buy').length, 0);
    }
  }
});

test('混合多日采样不自动跨日接回，卖飞统计不是利润', () => {
  const sample = (date, time, price, more = {}) => ({ date, time, price, premium: 17, live: true, tier: 'try', ...more });
  const samples = [sample(sale.date,'10:34',2.9,{sell:true}),sample(sale.date,'10:35',2.89),sample(sale.date,'10:36',2.95),
    sample('2026-11-09','10:34',2.85,{rebound:true}),sample('2026-11-09','10:35',2.84)];
  const r = S.replay(samples,10000);
  assert.equal(r.trades.filter(t=>t.side==='buy').length,0);
  assert.equal(r.flyCount,1);
});

test('普通卖出已无持仓时做T不得再提示卖出', () => {
  const ordinary={id:4,date:sale.date,time:'11:10',side:'sell',shares:10000,price:2.85};
  const m=market();m.quote.price=2.8;
  assert.equal(S.evaluate([base,sale,fill(),ordinary],m).action,null);
});

test('风险减仓不作为做T高抛，混合信号优先提示风险', () => {
  const risk = { time: '11:04', side: 'sell', risk: 'weak', title: '持续走弱' };
  const m = market({ events: [risk] });
  const v = S.evaluate([base], m);
  assert.equal(v.action, null);
  assert.match(v.state, /非高抛/);
  assert.equal(v.risk.title, '持续走弱');
  assert.equal(S.evaluate([base], market({ events: [risk, { time: '11:04', side: 'sell' }] })).action, null);
  assert.equal(S.evaluate([base], market({ events: [{ time: '11:04', side: 'sell' }] })).action, 'sell');
  assert.equal(S.evaluate([base], market({ events: [risk], live: false })).risk, null);
});

test('接回确认必须在实际卖出之后，卖出前信号不复用', () => {
  const laterSale = { ...sale, time: '11:05' };
  assert.equal(S.evaluate([base, laterSale], market()).action, null);
  assert.match(S.evaluate([base, laterSale], market()).state, /等止跌/);
  const m = market(); m.quote.quoteTime = '2026-11-06 11:06'; m.events = [{ time: '11:05', side: 'watch' }];
  assert.equal(S.evaluate([base, laterSale], m).action, 'buy');
});

test('做T状态明确区分价差不足、价格达标和实时风控阻止', () => {
  const m = market(); m.quote.price = 2.89;
  const v = S.evaluate([base, sale], m);
  assert.match(v.state, /价差不足/);
  assert.equal(v.buyTarget, S.targetPrice(sale, 2000));
  assert.equal(v.active.id, sale.id);
  assert.equal(S.evaluate([base, sale], market({ events: [] })).reboundConfirmed, false);
  const weak = market({ abort: true, events: [{ time: '11:04', side: 'watch' }, { time: '11:04', side: 'sell', risk: 'broken' }] });
  const blocked = S.evaluate([base, sale], weak);
  assert.equal(blocked.action, null);
  assert.ok(blocked.risk);
  assert.match(blocked.state, /禁止接回/);
});

test('部分接回和普通交易后接回上限按真实可恢复份额计算', () => {
  const partial = fill({ shares: 1000 });
  const v = S.evaluate([base, sale, partial], market());
  assert.equal(v.buyTarget, S.targetPrice(sale, 1000));
  const restored = { ...base, id: 4, date: sale.date, time: '11:00', shares: 2000 };
  assert.equal(S.evaluate([base, sale, restored], market()).buyTarget, null);
});

test('普通历史记录份额是字符串时仍按数字计算', () => {
  assert.equal(S.position([{ ...base, shares: '10000', price: '3' }, { ...sale, shares: '2000', price: '2.9' }]).shares, 8000);
});
