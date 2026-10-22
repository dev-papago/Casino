// Runs the simulator off the page's thread: { id, params } in, progress and the result out.
import { fastRng, simulate, type SimParams } from './engine.ts';

self.onmessage = (e: MessageEvent<{ id: number; params: SimParams }>) => {
  const { id, params } = e.data;
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const result = simulate(params, fastRng(seed), (done) => postMessage({ id, type: 'progress', done }));
  postMessage({ id, type: 'done', result });
};
