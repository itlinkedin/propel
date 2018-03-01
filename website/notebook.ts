/*!
   Copyright 2018 Propel http://propel.site/.  All rights reserved.
   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
 */

// Propel Notebooks.
// Note that this is rendered and executed server-side using JSDOM and then is
// re-rendered client-side. The Propel code in the cells are executed
// server-side so the results can be displayed even if javascript is disabled.

// tslint:disable:no-reference
/// <reference path="../node_modules/@types/codemirror/index.d.ts" />

import { escape } from "he";
import { Component, h } from "preact";
import { OutputHandlerDOM } from "../src/output_handler";
import { assert, delay, global, IS_NODE, IS_WEB, nodeRequire, URL }
  from "../src/util";
import { Avatar, GlobalHeader, Loading, UserMenu } from "./common";
import * as db from "./db";
import { RpcChannel } from "./nb_rpc_channel";

const cellTable = new Map<number, Cell>(); // Maps id to Cell.
let nextCellId = 1;
let lastExecutedCellId = null;

// Given a cell's id, which can either be an integer or
// a string of the form "cell5" (where 5 is the id), look up
// the component in the global table.
export function lookupCell(id: string | number) {
  let numId;
  if (typeof id === "string") {
    numId = Number(id.replace("cell", ""));
  } else {
    numId = id;
  }
  return cellTable.get(numId);
}

function createSandbox(): RpcChannel {
  const IS_JSDOM = /jsdom/.test(window.navigator.userAgent);

  const base = IS_JSDOM
    ? new URL(`file:///${__dirname}/../build/website/sandbox`).href
    : new URL("/sandbox", window.document.baseURI).href;

  const html = `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <base href="${escape(base, { isAttributeValue: true })}">
        <script type="text/javascript">
          console.log('aaa!');
        </script>
        <script async type="text/javascript" src="nb_sandbox.js">
        </script>
      </head>
      <body>
      </body>
    </html>`;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("src", `data:text/html,${html}`);
  iframe.style.display = "none";
  document.body.appendChild(iframe);

  if (IS_JSDOM) {
    iframe.contentWindow.fetch = window.fetch;
  }

  const sandbox = new RpcChannel(iframe.contentWindow, {
    console(cellId: number, ...args: string[]): void {
      const cell = lookupCell(cellId);
      cell.console(...args);
    },

    plot(cellId: number, data: any): void {
      const cell = lookupCell(cellId);
      cell.plot(data);
    },

    imshow(cellId: number, data: any): void {
      const cell = lookupCell(cellId);
      cell.plot(data);
    }
  });

  return sandbox;
}

let sandbox_: RpcChannel = null;
function sandbox(): RpcChannel {
  if (sandbox_ === null) {
    sandbox_ = createSandbox();
  }
  return sandbox_;
}

// Convenience function to create Notebook JSX element.
// TODO This function is badly named. It should be called notebookCell()
export function notebook(code: string, props: CellProps = {}): JSX.Element {
  props.code = code;
  return h(Cell, props);
}

// When rendering HTML server-side, all of the notebook cells are executed so
// their output can be placed in the generated HTML. This queue tracks the
// execution promises for each cell.
const cellExecuteQueue: Cell[] = [];

export async function drainExecuteQueue() {
  while (cellExecuteQueue.length > 0) {
    const cell = cellExecuteQueue.shift();
    await cell.run();
  }
}

const codemirrorOptions = {
  lineNumbers: false,
  lineWrapping: true,
  mode: "javascript",
  scrollbarStyle: null,
  theme: "syntax",
  viewportMargin: Infinity,
};

export interface CellProps {
  code?: string;
  onRun?: (code: null | string) => void;
  // If onDelete or onInsertCell is null, it hides the button.
  onDelete?: () => void;
  onInsertCell?: () => void;
}
export interface CellState { }

export class Cell extends Component<CellProps, CellState> {
  parentDiv: Element;
  input: Element;
  output: Element;
  editor: CodeMirror.Editor;
  readonly id: number;

  constructor(props) {
    super(props);
    this.id = nextCellId++;
    cellTable.set(this.id, this);
  }

  componentWillMount() {
    cellExecuteQueue.push(this);
  }

  get code(): string {
    return normalizeCode(this.editor ? this.editor.getValue()
                                     : this.props.code);
  }

  console(...args: string[]) {
    const output = this.output;
    const last = output.lastChild;
    let s = (last && last.nodeType !== Node.TEXT_NODE) ? "\n" : "";
    s += args.join(" ") + "\n";
    const el = document.createTextNode(s);
    output.appendChild(el);
  }

  plot(data) {
    const o = new OutputHandlerDOM(this.output);
    o.plot(data);
  }

  imshow(data) {
    const o = new OutputHandlerDOM(this.output);
    o.plot(data);
  }

  clearOutput() {
    this.output.innerHTML = "";
  }

  // Because CodeMirror has a lot of state that is not managed through
  // React, manually apply prop changes.
  componentWillReceiveProps(nextProps: CellProps) {
    const nextCode = normalizeCode(nextProps.code);
    if (nextCode !== this.code) {
      this.editor.setValue(nextCode);
      this.clearOutput();
    }
  }

  // Never update the component, because CodeMirror has complex state.
  // Code updates are done in componentWillReceiveProps.
  shouldComponentUpdate() {
    return false;
  }

  componentDidMount() {
    const options = Object.assign({}, codemirrorOptions, {
      mode: "javascript",
      value: this.code,
    });

    // If we're in node, doing server-side rendering, we don't enable
    // CodeMirror as its not clear if it can re-initialize its state after
    // being serialized.
    if (IS_WEB) {
      // tslint:disable:variable-name
      const CodeMirror = require("codemirror");
      require("codemirror/mode/javascript/javascript.js");

      // Delete existing pre.
      const pres = this.input.getElementsByTagName("pre");
      assert(pres.length === 1);
      this.input.removeChild(pres[0]);

      this.editor = CodeMirror(this.input, options);
      this.editor.setOption("extraKeys", {
        "Ctrl-Enter": () =>  {
          this.run();
          return true;
        },
        "Shift-Enter": () => {
          this.run();
          this.editor.getInputField().blur();
          this.focusNext();
          return true;
        },
      });

      this.editor.on("focus", () => {
        this.parentDiv.classList.add("notebook-cell-focus");
      });

      this.editor.on("blur", () => {
        this.parentDiv.classList.remove("notebook-cell-focus");
      });
    }
  }

  focusNext() {
    const cellsEl = this.parentDiv.parentElement;
    // Don't focus next if we're in the docs.
    if (cellsEl.className !== "cells") return;

    const nbCells = cellsEl.getElementsByClassName("notebook-cell");
    assert(nbCells.length > 0);

    // NodeListOf<Element> doesn't have indexOf. We loop instead.
    for (let i = 0; i < nbCells.length - 1; i++) {
      if (nbCells[i] === this.parentDiv) {
        const nextCellElement = nbCells[i + 1];
        const next = lookupCell(nextCellElement.id);
        assert(next != null);
        next.focus();
        return;
      }
    }
  }

  focus() {
    this.editor.focus();
    this.parentDiv.scrollIntoView();
  }

  // This method executes the code in the cell, and updates the output div with
  // the result. The onRun callback is called if provided.
  async run() {
    this.clearOutput();
    const classList = (this.input.parentNode as HTMLElement).classList;
    classList.add("notebook-cell-running");

    lastExecutedCellId = this.id;
    await sandbox().call("runCell", this.code, this.id);

    classList.add("notebook-cell-updating");
    await delay(100);
    classList.remove("notebook-cell-updating");
    classList.remove("notebook-cell-running");

    if (this.props.onRun) this.props.onRun(this.code);
  }

  clickedDelete() {
    console.log("Delete was clicked.");
    if (this.props.onDelete) this.props.onDelete();
  }

  clickedInsertCell() {
    console.log("NewCell was clicked.");
    if (this.props.onInsertCell) this.props.onInsertCell();
  }

  render() {
    const runButton = h("button", {
      "class": "run-button",
      "onClick": this.run.bind(this),
    }, "");

    let deleteButton = null;
    if (this.props.onDelete) {
      deleteButton = h("button", {
          "class": "delete-button",
          "onClick": this.clickedDelete.bind(this),
      }, "");
    }

    let insertButton = null;
    if (this.props.onInsertCell) {
      insertButton = h("button", {
          "class": "insert-button",
          "onClick": this.clickedInsertCell.bind(this),
      }, "");
    }

    return h("div", {
        "class": "notebook-cell",
        "id": `cell${this.id}`,
        "ref": (ref => { this.parentDiv = ref; }),
      },
      h("div", {
        "class": "input",
        "ref": (ref => { this.input = ref; }),
      },
        // This pre is replaced by CodeMirror if users have JavaScript enabled.
        h("pre", { }, this.code),
        deleteButton,
        runButton,
      ),
      h("div", { "class": "output-container" },
        h("div", {
          "class": "output",
          "id": "output" + this.id,
          "ref": (ref => { this.output = ref; }),
        }),
        insertButton,
      )
    );
  }
}

export interface FixedProps {
  code: string;
}

// FixedCell is for non-executing notebook-lookalikes. Usually will be used for
// non-javascript code samples.
// TODO share more code with Cell.
export class FixedCell extends Component<FixedProps, CellState> {
  render() {
    // Render as a pre in case people don't have javascript turned on.
    return h("div", { "class": "notebook-cell", },
      h("div", { "class": "input" },
        h("pre", { }, normalizeCode(this.props.code)),
      )
    );
  }
}

// This is to handle asynchronous output situations.
// Try to guess which cell we are executing in by looking at the stack trace.
// If there isn't a cell in there, then default to the lastExecutedCellId.
export function guessCellId(): number {
  const stacktrace = (new Error()).stack.split("\n");
  for (let i = stacktrace.length - 1; i >= 0; --i) {
    const line = stacktrace[i];
    const m = line.match(/__cell(\d+)__/);
    if (m) return Number(m[1]);
  }
  return lastExecutedCellId;
}

export function outputEl(): Element {
  const id = guessCellId();
  const cell = lookupCell(id);
  if (cell) {
    return cell.output;
  } else {
    return null;
  }
}

export interface NotebookRootProps {
  userInfo?: db.UserInfo;
  nbId?: string;
}

export interface NotebookRootState {
  nbId?: string;
}

export class NotebookRoot extends Component<NotebookRootProps,
                                            NotebookRootState> {
  constructor(props) {
    super(props);

    let nbId;
    if (this.props.nbId) {
      nbId = this.props.nbId;
    } else {
      const matches = window.location.search.match(/nbId=(\w+)/);
      nbId = matches ? matches[1] : null;
    }

    this.state = { nbId };
  }

  render() {
    let body;
    if (this.state.nbId) {
      body = h(Notebook, {
        nbId: this.state.nbId,
        userInfo: this.props.userInfo,
      });
    } else {
      body = h(MostRecent, null);
    }

    return h("div", { "class": "notebook" },
      h(GlobalHeader, {
        subtitle: "Notebook",
        subtitleLink: "/notebook",
      }, h(UserMenu, { userInfo: this.props.userInfo })),
      body,
    );
  }
}

export interface MostRecentState {
  latest: db.NbInfo[];
}

function nbUrl(nbId: string): string {
  // Careful, S3 is finicy about what URLs it serves. So
  // /notebook?nbId=blah  will get redirect to /notebook/
  // because it is a directory with an index.html in it.
  const u = window.location.origin + "/notebook/?nbId=" + nbId;
  return u;
}

export class MostRecent extends Component<any, MostRecentState> {
  async componentWillMount() {
    // Only query firebase when in the browser.
    // This is to avoiding calling into firebase during static HTML generation.
    if (IS_WEB) {
      const latest = await db.active.queryLatest();
      this.setState({latest});
    }
  }

  async onCreate() {
    console.log("Click new");
    const nbId = await db.active.create();
    // Redirect to new notebook.
    window.location.href = nbUrl(nbId);
  }

  render() {
    if (!this.state.latest) {
      return h(Loading, null);
    }
    const notebookList = this.state.latest.map(info => {
      const snippit = info.doc.cells.map(normalizeCode)
        .join("\n")
        .slice(0, 100);
      const href = nbUrl(info.nbId);
      return h("li", null,
        h("a", { href },
          notebookBlurb(info.doc, false),
          snippit
        ),
      );
    });
    return h("div", { "class": "most-recent" },
      h("button", {
        "class": "create-notebook",
        "onClick": () => this.onCreate(),
      }, "Create Empty Notebook"),
      h("h2", null, "Recently Updated"),
      h("ol", null, ...notebookList),
    );
  }
}

export interface NotebookProps {
  nbId: string;
  onReady?: () => void;
  userInfo?: db.UserInfo;  // Info about the currently logged in user.
}

export interface NotebookState {
  doc?: db.NotebookDoc;
  errorMsg?: string;
  isCloningInProgress: boolean;
}

// This defines the Notebook cells component.
export class Notebook extends Component<NotebookProps, NotebookState> {
  constructor(props) {
    super(props);
    this.state = {
      doc: null,
      errorMsg: null,
      isCloningInProgress: false,
    };
  }

   async componentWillMount() {
    try {
      const doc = await db.active.getDoc(this.props.nbId);
      this.setState({ doc });
    } catch (e) {
      this.setState({ errorMsg: e.message });
    }
  }

  private async update(doc): Promise<void> {
    this.setState({ doc });
    try {
      await db.active.updateDoc(this.props.nbId, doc);
    } catch (e) {
      this.setState({ errorMsg: e.message });
    }
  }

  async onRun(updatedCode: string, i: number) {
    const doc = this.state.doc;
    updatedCode = normalizeCode(updatedCode);
    // Save updated code in database if different.
    if (normalizeCode(doc.cells[i]) !== updatedCode) {
      doc.cells[i] = updatedCode;
      this.update(doc);
    }
  }

  async onDelete(i) {
    const doc = this.state.doc;
    doc.cells.splice(i, 1);
    this.update(doc);
  }

  async onInsertCell(i) {
    const doc = this.state.doc;
    doc.cells.splice(i + 1, 0, "");
    this.update(doc);
  }

  async onClone() {
    if (this.state.isCloningInProgress) {
      return;
    }
    console.log("Click clone");
    this.setState({ isCloningInProgress: true });
    const clonedId = await db.active.clone(this.state.doc);
    this.setState({ isCloningInProgress: false });
    // Redirect to new cloned notebook.
    window.location.href = nbUrl(clonedId);
  }

  get loading() {
    return this.state.doc == null;
  }

  renderCells(doc): JSX.Element {
    return h("div", { "class": "cells" }, doc.cells.map((code, i) => {
      return notebook(code, {
        onRun: (updatedCode) => { this.onRun(updatedCode, i); },
        onDelete: () => { this.onDelete(i); },
        onInsertCell: () => { this.onInsertCell(i); },
      });
    }));
  }

  render() {
    let body;

    if (this.state.errorMsg) {
      body = [
        h("h1", null, "Error"),
        h("b", null, this.state.errorMsg),
      ];

    } else if (this.state.doc == null) {
      body = [
        h(Loading, null)
      ];

    } else {
      const doc = this.state.doc;
      const cloneButton = this.props.userInfo == null ? ""
        : h("button", {
            "class": "clone",
            "onClick": () => this.onClone(),
          }, "Clone");

      body = [
        h("header", null, notebookBlurb(doc), cloneButton),
        this.renderCells(doc)
      ];
    }

    return h("div", null, ...body);
  }

  async componentDidUpdate() {
    await drainExecuteQueue();

    // We've rendered the Notebook with either a document or errorMsg.
    if (this.state.doc || this.state.errorMsg) {
      if (this.props.onReady) this.props.onReady();
    }
  }
}

function notebookBlurb(doc: db.NotebookDoc, showDates = true): JSX.Element {
  const dates = !showDates ? [] : [
    h("p", { "class": "created" }, `Created ${fmtDate(doc.created)}.`),
    h("p", { "class": "updated" }, `Updated ${fmtDate(doc.updated)}.`),
  ];
  return h("div", { "class": "blurb" }, null, [
    h(Avatar, { userInfo: doc.owner }),
    h("p", { "class": "displayName" }, doc.owner.displayName),
    ...dates
  ]);
}

function fmtDate(d: Date): string {
  return d.toISOString();
}

// Trims whitespace.
function normalizeCode(code: string): string {
  return code.trim();
}
