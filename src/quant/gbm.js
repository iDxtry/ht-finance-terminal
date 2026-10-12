import { createSeededNormal } from './random.js';

const MAX_SIMULATED_POINTS = 10_000_000;

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

/**
 * Simulate seeded Geometric Brownian Motion price paths.
 *
 * Assumptions: each step has independent standard-normal shocks; `drift` and
 * `volatility` are annualized continuously compounded drift and annualized
 * standard deviation; time steps are equally spaced; there are no dividends,
 * fees, jumps, stochastic volatility, or market-calendar effects. This is a
 * model scenario generator, not a forecast or a source of market prices.
 * The exact GBM transition is used, so every valid simulated price is positive.
 */
export function simulateMonteCarloGBM({
  initialPrice,
  drift = 0,
  volatility = 0.2,
  horizonYears = 1,
  steps = 252,
  pathCount = 1_000,
  seed = 1,
} = {}) {
  if (!Number.isFinite(initialPrice) || initialPrice <= 0) throw new RangeError('initialPrice must be a positive finite number.');
  if (!Number.isFinite(drift)) throw new TypeError('drift must be finite.');
  if (!Number.isFinite(volatility) || volatility < 0) throw new RangeError('volatility must be a non-negative finite number.');
  if (!Number.isFinite(horizonYears) || horizonYears <= 0) throw new RangeError('horizonYears must be a positive finite number.');
  positiveInteger(steps, 'steps');
  positiveInteger(pathCount, 'pathCount');
  if (steps * pathCount > MAX_SIMULATED_POINTS) {
    throw new RangeError(`steps × pathCount may not exceed ${MAX_SIMULATED_POINTS.toLocaleString()} simulated points.`);
  }

  const dt = horizonYears / steps;
  const diffusion = volatility * Math.sqrt(dt);
  const deterministicStep = (drift - 0.5 * volatility ** 2) * dt;
  const normal = createSeededNormal(seed);
  const paths = [];
  const finalPrices = [];

  for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
    const path = new Array(steps + 1);
    path[0] = initialPrice;
    let logPrice = Math.log(initialPrice);
    for (let stepIndex = 1; stepIndex <= steps; stepIndex += 1) {
      logPrice += deterministicStep + diffusion * normal();
      const price = Math.exp(logPrice);
      if (!Number.isFinite(price) || price <= 0) {
        throw new RangeError('A simulated price exceeded the supported numeric range; reduce drift, volatility, or horizon.');
      }
      path[stepIndex] = price;
    }
    paths.push(path);
    finalPrices.push(path[steps]);
  }

  return {
    paths,
    finalPrices,
    times: Array.from({ length: steps + 1 }, (_, index) => index * dt),
    parameters: { initialPrice, drift, volatility, horizonYears, steps, pathCount, seed },
  };
}

// Short alias for callers that already label this output as Monte Carlo.
export const simulateGbmPaths = simulateMonteCarloGBM;
