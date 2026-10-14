export { KernelEngine, evaluateOnKernel, kernelRequest, type KernelEvaluation } from './engine.js';
export { answerRequest, type DeferredCallOutcome, type KernelAnswerScope, type KernelCallService, type KernelHostPorts } from './host.js';
export { decodeProgress, decodeRequest } from './decode.js';
export type {
  CallerWire,
  IoAnswerWire,
  IoReplyWire,
  IoRequestWire,
  KernelModule,
  KernelServerHandle,
  PendingRequestWire,
  ServerProgressWire,
  Settled,
  SubstrateFailureWire,
} from './wire.js';
