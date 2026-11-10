(function (root, factory) {
  const strategy = factory();
  if (typeof module === 'object' && module.exports) module.exports = strategy;
  else root.EtfTStrategy = strategy;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const defaults = { fraction: 0.2, gap: 0.006, rate: 0.0001, minFee: 5, slippage: 0.001, stop: 0.008, fly: 0.01 };
  const fee = (amount, rules) => Math.max(rules.minFee, amount * rules.rate);
  const tradeFee = t => Number.isFinite(t.fee) ? t.fee : 0;
  const order = trades => [...trades].sort((a, b) => `${a.date} ${a.time || '00:00'}`.localeCompare(`${b.date} ${b.time || '00:00'}`) || Number(a.id) - Number(b.id));
  const cents = n => Math.round(n * 100) / 100;

  function position(trades) {
    let shares = 0, cost = 0, realized = 0;
    for (const t of order(trades)) {
      const quantity = Number(t.shares), price = Number(t.price);
      if (!(quantity > 0) || !(price > 0)) continue;
      if (t.side === 'buy') { shares += quantity; cost += quantity * price + tradeFee(t); }
      else {
        const qty = Math.min(shares, quantity), avg = shares > 0 ? cost / shares : 0;
        realized += qty * (price - avg) - tradeFee(t);
        cost -= qty * avg; shares -= qty;
      }
    }
    return { shares, cost, avgCost: shares > 0 ? cost / shares : 0, realized };
  }

  function cycles(trades, mark) {
    return order(trades).filter(t => t.tAction === 'sell').map(sale => {
      const rules = { ...defaults, ...sale.tRules };
      const children = order(trades).filter(t => String(t.tCycleId) === String(sale.id) && t.id !== sale.id);
      let bought = 0, held = 0, boughtCost = 0, heldCost = 0, heldPrincipal = 0, buyFees = 0, exitProceeds = 0, exitPnl = 0, exited = 0;
      const matches = [];
      for (const t of children) {
        if (t.tAction === 'buy') {
          bought += t.shares; held += t.shares;
          boughtCost += t.shares * t.price + tradeFee(t); heldCost += t.shares * t.price + tradeFee(t); heldPrincipal += t.shares * t.price;
          buyFees += tradeFee(t);
          matches.push({ date: t.date, time: t.time, shares: t.shares, price: t.price, fee: tradeFee(t),
            net: t.shares * (sale.price - t.price) - tradeFee(sale) * t.shares / sale.shares - tradeFee(t) });
        } else if (t.tAction === 'exit') {
          const avg = held > 0 ? heldCost / held : 0;
          exitProceeds += t.shares * t.price - tradeFee(t);
          exitPnl += t.shares * (t.price - avg) - tradeFee(t);
          heldCost -= t.shares * avg; heldPrincipal -= held > 0 ? t.shares * heldPrincipal / held : 0; held -= t.shares; exited += t.shares;
        }
      }
      const pending = Math.max(0, sale.shares - bought);
      const pairedNet = bought * sale.price - tradeFee(sale) * bought / sale.shares - boughtCost;
      const cash = sale.shares * sale.price - tradeFee(sale) - boughtCost + exitProceeds;
      const price = Number.isFinite(mark) && mark > 0 ? mark : null;
      const gapShares = pending + exited;
      const avgBuy = bought > 0 ? (boughtCost - buyFees) / bought : null;
      const stopPrice = held > 0 ? heldPrincipal / held * (1 - rules.stop) : null;
      const budgetPrice = pending > 0 ? targetPrice(sale, pending, rules) : null;
      const marks = sale.tMarks || [];
      let peak = 0, drawdown = 0;
      for (const m of marks) { peak = Math.max(peak, m.delta); drawdown = Math.min(drawdown, m.delta - peak); }
      return { id: sale.id, sale, rules, children, matches, bought, held, pending, exited, avgBuy,
        stopPrice, target: budgetPrice, pairedNet, cash, exitPnl,
        complete: pending === 0, abandoned: !!sale.tAbandoned,
        returnFloat: price != null ? held * price - heldCost : null,
        relativeHolding: price != null ? cash - gapShares * price : null,
        fly: pending > 0 && price != null && price >= sale.price * (1 + rules.fly),
        observedDrawdown: marks.length ? drawdown : null };
    });
  }

  function targetPrice(sale, qty, rules = { ...defaults, ...sale.tRules }) {
    if (!(qty > 0)) return null;
    const proceeds = qty * sale.price - tradeFee(sale) * qty / sale.shares;
    const budget = proceeds * (1 - rules.gap);
    let lo = 0, hi = sale.price;
    for (let i = 0; i < 50; i++) {
      const p = (lo + hi) / 2;
      if (qty * (p + rules.slippage) + fee(qty * (p + rules.slippage), rules) <= budget) lo = p;
      else hi = p;
    }
    return Math.max(0, Math.floor((lo + 1e-10) * 1000) / 1000);
  }

  function evaluate(trades, market, settings = defaults) {
    const rules = { ...defaults, ...settings, fraction: defaults.fraction };
    const quote = market.quote || {}, price = quote.price;
    const all = cycles(trades, price), pos = position(trades);
    const active = all.find(c => c.pending > 0 && !c.abandoned);
    const recoverable = active ? Math.floor(Math.max(0, Math.min(active.pending, active.sale.tBase - pos.shares)) / 100) * 100 : 0;
    const date = market.date;
    const minute = quote.quoteTime ? quote.quoteTime.slice(11, 16) : '';
    const recentEvents = (market.events || []).filter(e => {
      const age = minutes(minute) - minutes(e.time);
      return age >= 1 && age <= 2;
    });
    const current = all.filter(c => c.sale.date === date);
    const cap = current.length ? current[0].sale.tCap : Math.floor(pos.shares * rules.fraction / 100) * 100;
    const used = current.reduce((s, c) => s + c.sale.shares, 0);
    const exit = pos.shares > 0 ? all.find(c => c.held > 0 && c.stopPrice != null && price <= c.stopPrice) : null;
    const round = exit || active || current[current.length - 1] || null;
    const riskEvent = market.live && pos.shares > 0 ? recentEvents.find(e => e.side === 'sell' && e.risk) : null;
    const buyTarget = active && recoverable > 0 ? targetPrice(active.sale, recoverable, active.rules) : null;
    const reboundConfirmed = !!(active && active.sale.date === date && recentEvents.some(e =>
      (e.side === 'buy' || e.side === 'watch') && e.time >= active.sale.time));
    let state = '等待高抛', note = `每天最多卖出底仓20%，今日总额度 ${Math.max(0, cap || 0)} 份；只有转弱确认后才是卖出候选。`, action = null;
    if (!market.live) { state = '非实时 · 仅记账'; note = '不发交易候选；已成交记录仍可录入，历史提示不补造订单。'; }
    else if (exit) { state = '接回后止损候选'; note = `接回仓位跌破 ${(exit.stopPrice).toFixed(3)}，按实际可卖回补仓位 ${Math.min(exit.held, pos.shares)} 份考虑退出；只提示，不自动卖出。`; action = 'exit'; }
    else if (active) {
      state = '等待低价接回'; note = `剩余待配对 ${active.pending} 份，当前可接回 ${recoverable} 份，最高参考接回价 ${targetPrice(active.sale, recoverable || active.pending, active.rules).toFixed(3)}；卖后上涨不追，绝不超过原来卖出的份额。`;
      if (active.abandoned || active.sale.date !== date) { state = '已过接回期限'; note = '只保留减仓，不自动跨日接回；可结束本轮或如实记录已发生的成交。'; }
      else if (active.exited > 0) { state = '本轮已退出 · 不再接回'; note = '回补仓已发生退出，不反复加回；剩余缺口保留减仓。'; }
      else if (minute >= '14:30') { state = '14:30后不再接回'; note = '保留已减仓结果，不为凑成一轮而追买。'; }
      else if (active.fly) { state = '卖后上涨 · 不追买'; note = `现价高于实际卖价 ${active.sale.price.toFixed(3)} 至少1%，记录卖飞风险，不保证低价接回。`; }
      else if (!['heavy', 'try'].includes(market.tier) || market.abort || riskEvent) { state = '趋势／失效风控 · 禁止接回'; note += ' 不因做T而绕过原有买入条件。'; }
      else if (recoverable <= 0) { state = '总持仓已恢复 · 不再接回'; note = '其他交易已恢复本轮卖出前的总持仓，禁止额外叠加接回。'; }
      else if (price <= buyTarget && reboundConfirmed) {
        state = '低价接回候选'; note += ' 价格已覆盖费用、滑点和最低净价差，且卖出后出现新止跌确认；成交后手动记录。'; action = 'buy';
      } else if (price > buyTarget) {
        state = '价差不足 · 等低价'; note += ` 现价仍需回落 ${((1 - buyTarget / price) * 100).toFixed(2)}% 才到费用后上限，触价后仍需新的止跌确认。`;
      } else { state = '价格达标 · 等止跌'; note += ' 费用后价差已达标，但尚无卖出后的新止跌确认，不因触价直接接回。'; }
    } else if (riskEvent) { state = '风险减仓 · 非高抛'; note = 'ETF持续走弱或破位，这是已有仓位风险预警，不是反弹高抛机会；不启动做T候选，也不承诺减仓后能够接回。'; }
    else if (current.length) { state = '今日一轮已结束'; note = '每天最多一轮，不反复追逐小波动；已接回仓位仍监控止损。'; }
    else if (pos.shares < 500 || cap < 100) { state = '底仓不足'; note = '先记录真实底仓；没有可卖份额时不做T，不模拟裸卖。'; }
    else if (recentEvents.some(e => e.side === 'sell' && !e.risk)) { state = '分批高抛候选'; action = 'sell'; }
    const risk = riskEvent ? { title: riskEvent.title || '持续走弱 · 风险减仓预警', time: riskEvent.time,
      note: '风险减仓与做T高抛分开，停止接跌；如实际减仓，用普通卖出记录，不建立等待接回轮次。' } : null;
    const closed = all.filter(c => c.complete);
    const days = [...new Set(all.map(c => c.sale.date))].map(d => ({ date: d, net: Number.isFinite(price) ? all.filter(c => c.sale.date === d).reduce((s, c) => s + (c.relativeHolding || 0), 0) : null }));
    return { state, note, action, risk, round, active, buyTarget, reboundConfirmed, pos, cap: Math.max(0, cap || 0), remainingQuota: Math.max(0, (cap || 0) - used), cycles: all, recoverable,
      stats: { rounds: all.length, closed: closed.length, wins: Number.isFinite(price) ? closed.filter(c => c.relativeHolding > 0).length : null,
        pairedNet: all.reduce((s, c) => s + c.pairedNet, 0),
        exitPnl: all.reduce((s, c) => s + c.exitPnl, 0),
        relativeHolding: Number.isFinite(price) ? all.reduce((s, c) => s + (c.relativeHolding || 0), 0) : null,
        worstRound: Number.isFinite(price) && all.length ? Math.min(...all.map(c => c.relativeHolding)) : null,
        worstDay: Number.isFinite(price) && days.length ? Math.min(...days.map(d => d.net)) : null,
        flyCount: all.filter(c => c.sale.tFly || c.fly).length,
        drawdown: all.some(c => c.observedDrawdown != null) ? Math.min(...all.map(c => c.observedDrawdown || 0)) : null,
        days } };
  }

  function minutes(t) { return /^\d{2}:\d{2}$/.test(t || '') ? +t.slice(0, 2) * 60 + +t.slice(3) : -1; }

  function validateFill(trades, fill) {
    if ((fill.tAction === 'sell' || fill.tAction === 'exit') && fill.side !== 'sell' || fill.tAction === 'buy' && fill.side !== 'buy') return '做T动作与交易方向不符。';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fill.date) || !Number.isFinite(Date.parse(fill.date)) || !/^\d{2}:\d{2}$/.test(fill.time) || Number(fill.time.slice(3)) >= 60 || Number(fill.time.slice(0, 2)) >= 24 || minutes(fill.time) < 570 || minutes(fill.time) > 900 || (minutes(fill.time) > 690 && minutes(fill.time) < 780)) return '请填写真实交易日期与交易时段内的时间。';
    if (!Number.isFinite(fill.price) || fill.price <= 0 || !Number.isInteger(fill.shares) || fill.shares <= 0 || !Number.isFinite(fill.fee) || fill.fee < 0) return '成交价、份额、费用无效。';
    const earlier = order(trades).filter(t => `${t.date} ${t.time || '00:00'}` <= `${fill.date} ${fill.time}`);
    if (fill.side === 'sell' && fill.shares > position(earlier).shares) return '卖出份额超过该时间已记录的持仓。';
    if (fill.tAction === 'sell') {
      if (cycles(earlier).some(c => c.pending > 0 && !c.abandoned)) return '已有未结束的做T轮次，请先处理。';
      if (trades.some(t => t.tAction === 'sell' && t.date === fill.date)) return '固定规则每天最多一轮。';
      const cap = Math.floor(position(earlier).shares * defaults.fraction / 100) * 100;
      if (fill.tBase !== position(earlier).shares || !Number.isFinite(fill.tCap) || fill.tCap !== cap || fill.shares % 100 || fill.shares > cap) return '做T份额须为100的整数倍，且不能超过底仓20%额度。';
    } else if (fill.tAction) {
      const c = cycles(earlier).find(r => String(r.id) === String(fill.tCycleId));
      if (!c) return '找不到对应实际卖出记录。';
      if (`${fill.date} ${fill.time}` < `${c.sale.date} ${c.sale.time}`) return '成交不能早于本轮卖出时间。';
      if (fill.tAction === 'buy' && (fill.shares % 100)) return '接回份额须为100的整数倍。';
      if (fill.tAction === 'buy' && fill.shares > c.pending) return '接回不能超过本轮尚未接回的实际卖出份额。';
      if (fill.tAction === 'buy' && position(earlier).shares + fill.shares > c.sale.tBase) return '接回后总持仓不能超过本轮卖出前的真实底仓。';
      if (fill.tAction === 'exit' && fill.shares > c.held) return '退出不能超过本轮实际接回后剩余份额。';
      const linked = order([...trades, fill]).filter(t => String(t.tCycleId) === String(c.id));
      let bought = 0, held = 0;
      for (const t of linked) {
        if (t.tAction === 'buy') { bought += t.shares; held += t.shares; }
        else if (t.tAction === 'exit') held -= t.shares;
        if (bought > c.sale.shares || held < 0) return '补录成交会破坏后续已记录的接回或退出份额。';
      }
    }
    return '';
  }

  function replay(samples, baseShares, settings = defaults) {
    const rules = { ...defaults, ...settings, fraction: defaults.fraction };
    const cap = Math.floor(baseShares * rules.fraction / 100) * 100;
    if (!samples.length || cap < 100) return { trades: [], pairedNet: 0, relativeHolding: 0, note: '历史采样或底仓不足。' };
    let sale = null, bought = false, returnedPrice = null, cash = 0, held = baseShares, peak = 0, mdd = 0, soldTooEarly = false;
    const trades = [];
    for (let i = 0; i < samples.length - 1; i++) {
      const now = samples[i], next = samples[i + 1];
      if (next.date !== now.date || minutes(next.time) - minutes(now.time) !== 1 || !now.live || !next.live
        || !(now.price > 0) || !(next.price > rules.slippage) || minutes(now.time) >= 900 || minutes(next.time) > 900) continue;
      if (!sale && now.sell) {
        const price = next.price - rules.slippage, f = fee(cap * price, rules);
        sale = { id: 1, date: next.date, time: next.time, price, shares: cap, fee: f, tRules: rules };
        cash += price * cap - f; held -= cap;
        trades.push({ side: 'sell', ...sale });
      } else if (sale && sale.date === now.date && !bought && now.rebound && next.time < '14:30'
        && ['try', 'heavy'].includes(now.tier) && ['try', 'heavy'].includes(next.tier) && !now.abort && !next.abort
        && now.price <= targetPrice(sale, cap, rules) && next.price <= targetPrice(sale, cap, rules)) {
        returnedPrice = next.price + rules.slippage;
        const f = fee(cap * returnedPrice, rules); cash -= returnedPrice * cap + f; held += cap; bought = true;
        trades.push({ side: 'buy', time: next.time, price: returnedPrice, shares: cap, fee: f });
      } else if (bought && held === baseShares && now.price <= returnedPrice * (1 - rules.stop)) {
        const price = next.price - rules.slippage, f = fee(cap * price, rules);
        cash += price * cap - f; held -= cap;
        trades.push({ side: 'exit', time: next.time, price, shares: cap, fee: f });
      }
      if (sale && !bought && next.price >= sale.price * (1 + rules.fly)) soldTooEarly = true;
      const delta = cash - (baseShares - held) * next.price; peak = Math.max(peak, delta); mdd = Math.min(mdd, delta - peak);
    }
    const last = samples[samples.length - 1];
    const buy = trades.find(t => t.side === 'buy');
    const pairedNet = buy ? cap * (sale.price - buy.price) - sale.fee - buy.fee : 0;
    return { trades, pairedNet: cents(pairedNet), relativeHolding: cents(cash - (baseShares - held) * last.price), drawdown: cents(mdd), flyCount: soldTooEarly ? 1 : 0,
      note: '仅回放本页留存的实时风险采样；下一连续分钟模拟成交，含费用和滑点，缺失期间不补造交易，不是完整历史回测。' };
  }

  return { defaults, fee, position, cycles, targetPrice, evaluate, validateFill, replay, order };
});
