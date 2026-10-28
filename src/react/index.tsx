/**
 * Headless React components and hooks of a nanocode chat. A skin maps each part to class names.
 *
 * @module
 */
export {
  AttachmentList,
  type Attachments,
  maxAttachments,
  type PendingAttachment,
  useAttachments,
} from './Attachments.tsx'
export {
  Chat,
  type Command,
  type Disclosure,
  EntryView,
  type Picker,
  Sidebar,
  type Suggestion,
  Thinking,
} from './Chat.tsx'
export { Code, fences } from './Code.tsx'
export { Hand, HandConnect, type HandState, useHand } from './Hand.tsx'
export { Image, imageSource, useWorkspaceFile } from './Image.tsx'
export { Markdown, Reply } from './Markdown.tsx'
export {
  type Highlighter,
  NanocodeProvider,
  type Part,
  type PartProps,
  type PartState,
  preloadMarkdown,
  type Skin,
  type Token,
  useActivity,
  useAnswer,
  useConfig,
  useConversations,
  useExpanded,
  useHighlighter,
  useLinks,
  useNote,
  usePart,
  useSend,
  useSkin,
  useTranscript,
  useTurns,
} from './Provider.tsx'
export { ToolCell } from './ToolCell.tsx'
