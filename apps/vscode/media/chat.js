// The chat panel's script.
//
// Runs in the webview, which is a separate document with no access to the
// extension host. It renders the view model the extension posts and posts back
// exactly two messages: a prompt to submit, and a cancel.
//
// Every piece of model- or tool-produced text is written with `textContent`, never
// `innerHTML`. Model output is untrusted data, and this panel is the one place it
// would be rendered as markup if anyone let it.

const vscode = acquireVsCodeApi();

const transcript = document.getElementById('transcript');
const statusBox = document.getElementById('status');
const composer = document.getElementById('composer');
const promptBox = document.getElementById('prompt');
const cancelButton = document.getElementById('cancel');
const sendButton = document.getElementById('send');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toolLine(tool) {
  const row = el('li', `tool tool-${tool.state}`);
  row.append(el('span', 'tool-name', tool.name));
  row.append(el('span', 'tool-state', tool.state));
  if (tool.truncated) row.append(el('span', 'tool-flag', 'truncated'));
  if (tool.detail !== undefined) row.append(el('span', 'tool-detail', tool.detail));
  return row;
}

function editLine(edit) {
  const row = el('li', `edit edit-${edit.state}`);
  row.append(el('span', 'edit-path', edit.path));
  row.append(el('span', 'edit-state', edit.state));
  if (edit.tier !== undefined) row.append(el('span', 'edit-meta', `tier ${edit.tier}`));
  if (edit.strategy !== undefined) row.append(el('span', 'edit-meta', edit.strategy));
  if (edit.validator !== undefined) {
    row.append(el('span', 'edit-meta', `validator ${edit.validator}`));
  }
  if (edit.reason !== undefined) row.append(el('span', 'edit-reason', edit.reason));
  if (edit.message !== undefined) row.append(el('p', 'edit-message', edit.message));
  return row;
}

function todoLine(todo) {
  return el('li', `todo todo-${todo.status}`, `${todo.status}: ${todo.content}`);
}

function listSection(title, items, render) {
  if (items.length === 0) return undefined;
  const section = el('section', 'group');
  section.append(el('h2', undefined, title));
  const list = el('ul');
  for (const item of items) list.append(render(item));
  section.append(list);
  return section;
}

function appendIfPresent(parent, node) {
  if (node !== undefined) parent.append(node);
}

function renderTranscript(state) {
  transcript.replaceChildren();
  if (state.assistantText !== '') {
    transcript.append(el('pre', 'assistant', state.assistantText));
  }
  appendIfPresent(transcript, listSection('Plan', state.todos, todoLine));
  appendIfPresent(transcript, listSection('Tools', state.tools, toolLine));
  appendIfPresent(transcript, listSection('Edits', state.edits, editLine));
  transcript.scrollTop = transcript.scrollHeight;
}

function renderStatus(state) {
  statusBox.replaceChildren();
  for (const warning of state.warnings) {
    statusBox.append(el('p', 'warning', `${warning.code}: ${warning.message}`));
  }
  if (state.droppedEvents > 0) {
    statusBox.append(
      el('p', 'error', `${state.droppedEvents} event(s) dropped; this transcript is incomplete.`),
    );
  }
  if (state.status === 'running') {
    statusBox.append(el('p', 'running', `running - step ${state.steps}`));
  }
  if (state.stopReason !== undefined) {
    statusBox.append(el('p', `stop stop-${state.stopReason}`, `stopped: ${state.stopReason}`));
  }
  if (state.message !== undefined) statusBox.append(el('p', 'detail', state.message));
}

function renderState(state) {
  renderTranscript(state);
  renderStatus(state);
  const running = state.status === 'running';
  cancelButton.disabled = !running;
  sendButton.disabled = running;
}

function renderNotice(message) {
  statusBox.replaceChildren(el('p', message.level, message.text));
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message === null || typeof message !== 'object') return;
  if (message.type === 'state') renderState(message.state);
  else if (message.type === 'notice') renderNotice(message);
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const prompt = promptBox.value;
  if (prompt.trim() === '') return;
  vscode.postMessage({ type: 'submit', prompt });
  promptBox.value = '';
});

cancelButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'cancel' });
});
