/**
 * Clone entrypoint: chat pages in the style of ChatGPT and Claude, and the hooks they share.
 *
 * @module
 */
export { ChatGpt } from './clones/ChatGpt.tsx'
export { Claude } from './clones/Claude.tsx'
export {
  type CloneModel,
  type ClonePicker,
  type CloneProps,
  CopyCode,
  grouped,
  useComposer,
  useDismiss,
  useGreeting,
  useResume,
  useSidebar,
  useStick,
} from './clones/Shared.tsx'
