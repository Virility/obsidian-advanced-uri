import {
    FileView,
    MarkdownView,
    Notice,
    TAbstractFile,
    TFile,
    WorkspaceLeaf,
} from "obsidian";
import AdvancedURI from "./main";
import { EnterDataModal } from "./modals/enter_data_modal";
import { FileModal } from "./modals/file_modal";
import Tools from "./tools";
import {
    CanvasView,
    FileExplorerView,
    MetadataEditor,
    MetadataFocusMode,
    Parameters,
} from "./types";
import "./types.ts";
import {
    copyText,
    getEndAndBeginningOfBlock,
    getEndAndBeginningOfHeading,
    getAlternativeFilePath,
    getObjFieldByPath,
    updateObjectFieldInplace,
    KeyPathError,
    waitForFileCache,
} from "./utils";

/**
 * Placeholder inside `insertatcursor` that is replaced with the system
 * clipboard content before the text is inserted.
 */
const CLIPBOARD_TOKEN = "{{clipboard}}";

const sleep = (ms: number) =>
    new Promise((resolve) => window.setTimeout(resolve, ms));

export default class Handlers {
    constructor(private readonly plugin: AdvancedURI) {}
    app = this.plugin.app;
    public get tools(): Tools {
        return this.plugin.tools;
    }

    handlePluginManagement(parameters: Parameters): void {
        if (parameters["enable-plugin"]) {
            const pluginId = parameters["enable-plugin"];

            if (
                pluginId in this.app.plugins.manifests &&
                !this.app.plugins.getPlugin(pluginId)
            ) {
                this.app.plugins.enablePluginAndSave(pluginId);
                new Notice(`Enabled ${pluginId}`);
            } else if (this.app.internalPlugins.plugins[pluginId]) {
                this.app.internalPlugins.plugins[pluginId].enable(true);
                new Notice(`Enabled ${pluginId}`);
            }
        } else if (parameters["disable-plugin"]) {
            const pluginId = parameters["disable-plugin"];

            if (this.app.plugins.getPlugin(pluginId)) {
                this.app.plugins.disablePluginAndSave(pluginId);
                new Notice(`Disabled ${pluginId}`);
            } else if (this.app.internalPlugins.plugins[pluginId]) {
                this.app.internalPlugins.plugins[pluginId].disable(true);
                new Notice(`Disabled ${pluginId}`);
            }
        }
    }

    async handleFrontmatterKey(parameters: Parameters) {
        const key = parameters.frontmatterkey;
        const file = this.app.vault.getAbstractFileByPath(
            parameters.filepath ?? this.app.workspace.getActiveFile().path
        );

        // could not handle frontmatter key that is not a TFile
        if (!(file instanceof TFile)) {
            return;
        }

        const cache = await waitForFileCache(this.app, file);
        if (!cache) {
            return;
        }
        const frontmatter = cache.frontmatter;

        // update frontmatter if user passed data
        if (parameters.data) {
            // parse data
            let data: unknown = parameters.data;
            try {
                // This try catch is needed to allow passing strings as a data value without extra ".
                data = JSON.parse(parameters.data);
            } catch {
                try {
                    data = JSON.parse(`"${parameters.data}"`);
                } catch (e) {
                    new Notice(
                        "Failed to parse data, check console for more details"
                    );
                    console.error(e);
                    return;
                }
            }

            // update frontmatter
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                try {
                    updateObjectFieldInplace({
                        originalObject: fm as Record<string, unknown>,
                        key,
                        data,
                    });
                } catch (e) {
                    console.error(e);
                    if (e instanceof KeyPathError) {
                        new Notice(`Invalid key in path.\n${e.message}`);
                    } else {
                        new Notice(
                            "Failed to update frontmatter, check console for more details"
                        );
                    }
                }
            });
        }

        if (frontmatter && !parameters.data) {
            // if no data is passed, just copy the frontmatter key value to clipboard
            const fieldValue = getObjFieldByPath({ obj: frontmatter, key });
            const clipboardValue =
                typeof fieldValue === "string" ||
                typeof fieldValue === "number" ||
                typeof fieldValue === "boolean"
                    ? String(fieldValue)
                    : JSON.stringify(fieldValue ?? "");
            await copyText(clipboardValue);
        }
        const leaf = await this.plugin.open({
            parameters,
            file,
            setting: this.plugin.settings.openFileWithoutWriteInNewPane,
        });

        if (leaf && parameters.mode) {
            if (leaf.view instanceof MarkdownView) {
                const metadataEditor = (
                    leaf.view as MarkdownView & {
                        metadataEditor?: MetadataEditor;
                    }
                ).metadataEditor;
                if (!metadataEditor) return;
                let mode: MetadataFocusMode;
                switch (parameters.mode) {
                    case "append":
                        mode = "end";
                        break;
                    case "prepend":
                        mode = "start";
                        break;
                    case "overwrite":
                        mode = "both";
                        break;
                }
                metadataEditor.focusValue(key, mode);
            }
        }
    }

    async handleWorkspace(parameters: Parameters): Promise<void> {
        const workspaces =
            this.app.internalPlugins.getEnabledPluginById("workspaces");
        if (!workspaces) {
            new Notice("Workspaces plugin is not enabled");
            this.plugin.failure(parameters);
        } else {
            if (parameters.saveworkspace == "true") {
                const active = workspaces.activeWorkspace;
                workspaces.saveWorkspace(active);
                new Notice(`Saved current workspace to ${active}`);
            }
            if (parameters.clipboard && parameters.clipboard != "false") {
                await this.tools.copyURI({
                    workspace: workspaces.activeWorkspace,
                });
            } else if (parameters.workspace != undefined) {
                workspaces.loadWorkspace(parameters.workspace);
            }
            this.plugin.success(parameters);
        }
    }

    async handleCommand(parameters: Parameters) {
        if (parameters.filepath) {
            if (parameters.mode) {
                if (parameters.mode == "new") {
                    const file = this.app.metadataCache.getFirstLinkpathDest(
                        parameters.filepath,
                        "/"
                    );
                    if (file instanceof TFile) {
                        parameters.filepath = getAlternativeFilePath(
                            this.app,
                            file
                        );
                    }
                }
                await this.plugin.open({
                    file: parameters.filepath,
                    mode: "source",
                    parameters: parameters,
                });
                const view =
                    this.app.workspace.getActiveViewOfType(MarkdownView);
                if (view) {
                    const editor = view.editor;
                    if (parameters.mode === "append") {
                        this.insertCommandLine(view, parameters, "append");
                    } else if (parameters.mode === "prepend") {
                        this.insertCommandLine(view, parameters, "prepend");
                    } else if (parameters.mode === "overwrite") {
                        editor.setValue("");
                    }
                }
            } else if (
                parameters.line != undefined ||
                parameters.column != undefined ||
                parameters.offset != undefined
            ) {
                await this.plugin.open({
                    file: parameters.filepath,
                    mode: "source",
                    parameters: parameters,
                });

                await this.plugin.setCursorInLine(parameters);
            } else {
                await this.plugin.open({
                    file: parameters.filepath,
                    setting: this.plugin.settings.openFileWithoutWriteInNewPane,
                    parameters: parameters,
                });
            }
        } else if (parameters.openmode || parameters.viewmode) {
            // Open a new leaf without a file. For example in a new window or split
            await this.plugin.open({
                parameters: parameters,
            });
        }
        if (parameters.commandid) {
            this.app.commands.executeCommandById(parameters.commandid);
        } else if (parameters.commandname) {
            const rawCommands = this.app.commands.commands;
            for (const command in rawCommands) {
                if (rawCommands[command].name === parameters.commandname) {
                    if (rawCommands[command].callback) {
                        await rawCommands[command].callback();
                    } else {
                        rawCommands[command].checkCallback(false);
                    }
                    break;
                }
            }
        }

        if (parameters.confirm && parameters.confirm != "false") {
            await new Promise((r) => window.setTimeout(r, 750));
            const element = document.querySelector(
                ".mod-cta:not([style*='display: none'])"
            );
            const button = element as HTMLButtonElement;
            if (button.click instanceof Function) {
                button.click();
            }
        }
        this.plugin.success(parameters);
        // Add huge delay to allow for example the frontmatter to be properly
        // cached before editing in `handleFrontmatterKey`
        await new Promise((r) => window.setTimeout(r, 4000));
    }

    private insertCommandLine(
        view: MarkdownView,
        parameters: Parameters,
        mode: "append" | "prepend"
    ) {
        const editor = view.editor;
        const lineCount = editor.lineCount();
        const lastExistingLine = editor.lastLine();
        let cursor: { line: number; ch: number };
        let keepCursorBeforeInsertedText = false;

        if (parameters.heading) {
            const headingInfo = getEndAndBeginningOfHeading(
                this.app,
                view.file,
                parameters.heading
            );
            if (!headingInfo) return;

            const line =
                mode === "append" ? headingInfo.lastLine : headingInfo.firstLine;
            if (line >= lineCount) {
                cursor = {
                    line: lastExistingLine,
                    ch: editor.getLine(lastExistingLine).length,
                };
            } else {
                cursor = { line, ch: 0 };
                keepCursorBeforeInsertedText = true;
            }
        } else if (parameters.block) {
            const blockInfo = getEndAndBeginningOfBlock(
                this.app,
                view.file,
                parameters.block
            );
            if (!blockInfo) return;

            cursor =
                mode === "append"
                    ? {
                          line: blockInfo.lastLine,
                          ch: editor.getLine(blockInfo.lastLine).length,
                      }
                    : { line: blockInfo.firstLine, ch: 0 };
            keepCursorBeforeInsertedText = mode === "prepend";
        } else if (mode === "append") {
            cursor = {
                line: lastExistingLine,
                ch: editor.getLine(lastExistingLine).length,
            };
        } else {
            cursor = { line: 0, ch: 0 };
            keepCursorBeforeInsertedText = true;
        }

        editor.replaceRange("\n", cursor);
        editor.setCursor(
            keepCursorBeforeInsertedText
                ? cursor
                : { line: cursor.line + 1, ch: 0 }
        );
        editor.scrollIntoView(
            {
                from: editor.getCursor(),
                to: editor.getCursor(),
            },
            true
        );
    }

    async handleDoesFileExist(parameters: Parameters) {
        const exists = await this.app.vault.adapter.exists(parameters.filepath);

        await copyText((exists ? 1 : 0).toString());
        this.plugin.success(parameters);
    }

    async handleReveal(parameters: Parameters) {
        const file = this.app.vault.getAbstractFileByPath(parameters.filepath);
        if (!file) {
            new Notice("Cannot find file or folder");
            this.plugin.failure(parameters);
            return;
        }

        const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
        const view = leaf?.view as FileExplorerView | undefined;
        if (!view || typeof view.revealInFolder !== "function") {
            new Notice("File Explorer is not available");
            this.plugin.failure(parameters);
            return;
        }

        view.revealInFolder(file);
        this.plugin.success(parameters);
    }

    handleRemovedEval(parameters: Parameters) {
        new Notice(
            "The eval URI parameter was removed due to security concerns and newer Obsidian plugin checks."
        );
        this.plugin.failure(parameters);
    }
    async handleSearchAndReplace(parameters: Parameters) {
        let file: TFile;
        if (parameters.filepath) {
            const abstractFile = this.app.vault.getAbstractFileByPath(
                parameters.filepath
            );
            if (abstractFile instanceof TFile) {
                file = abstractFile;
            }
        } else {
            file = this.app.workspace.getActiveFile();
        }

        if (file) {
            let data = await this.app.vault.read(file);
            if (parameters.searchregex) {
                try {
                    const [, , pattern, flags] =
                        parameters.searchregex.match(/(\/?)(.+)\1([a-z]*)/i);
                    const regex = new RegExp(pattern, flags);
                    data = data.replace(regex, parameters.replace);
                    this.plugin.success(parameters);
                } catch {
                    new Notice(
                        `Can't parse ${parameters.searchregex} as RegEx`
                    );
                    this.plugin.failure(parameters);
                }
            } else {
                data = data.replaceAll(parameters.search, parameters.replace);
                this.plugin.success(parameters);
            }

            await this.plugin.writeAndOpenFile(file.path, data, parameters);
        } else {
            new Notice("Cannot find file");
            this.plugin.failure(parameters);
        }
    }

    async handleSearch(parameters: Parameters) {
        if (parameters.filepath) {
            await this.plugin.open({
                file: parameters.filepath,
                parameters: parameters,
            });
        }
        const view = this.app.workspace.getActiveViewOfType(FileView);
        view.currentMode.showSearch();
        const search = view.currentMode.search;
        search.searchInputEl.value = parameters.search;
        search.searchInputEl.dispatchEvent(new Event("input"));
    }

    /**
     * Resolves the MarkdownView that "insertatcursor" should target.
     *
     * Order: the active markdown leaf, then the most recently used one. The
     * caller contract sends no `filepath`, so this must work purely off what
     * the workspace already has open -- it never opens or creates a note.
     */
    private resolveInsertionTarget(): MarkdownView | null {
        const active = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (active) return active;

        // The active leaf may be a canvas/graph/sidebar pane. Obsidian exposes
        // no public "recent leaves" list, so use the most recently active leaf
        // (`getMostRecentLeaf` is documented to reach the root split even while
        // a sidebar leaf is active), then fall back to scanning open leaves.
        // This scan is unordered, so it is only a last resort: it can pick a
        // markdown leaf that is not strictly the most recently used one.
        const recent = this.app.workspace.getMostRecentLeaf();
        const recentView =
            recent?.view instanceof MarkdownView ? recent.view : null;
        if (recentView) return recentView;

        let found: MarkdownView | null = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (!found && leaf.view instanceof MarkdownView) {
                found = leaf.view;
            }
        });
        return found;
    }

    /**
     * Reveals `leaf`, tolerating Obsidian versions that predate
     * `workspace.revealLeaf` (`@since 1.7.2`; this plugin allows 1.5.7).
     *
     * The `setActiveLeaf` fallback makes the leaf active but may not scroll a
     * background tab into view. That is acceptable here: `editor.focus()` and
     * the caret re-assert in `focusInsertionTarget()` still run afterwards, so
     * the insert lands at the caret even when the reveal could not scroll.
     */
    private async revealLeafCompat(leaf: WorkspaceLeaf): Promise<void> {
        const ws: any = this.app.workspace;
        if (typeof ws.revealLeaf === "function") return ws.revealLeaf(leaf);
        ws.setActiveLeaf?.(leaf, { focus: true });
    }

    /**
     * Makes `view` the active tab, the focused pane, and puts the caret back
     * where the user left it.
     */
    private async focusInsertionTarget(view: MarkdownView): Promise<void> {
        // revealLeaf MUST run before focus(). Focusing an editor that lives in a
        // background tab changes nothing the user can see: the leaf is not
        // rendered, so the caret never paints and scrollIntoView has no visible
        // effect. revealLeaf activates and renders the leaf first, which is what
        // makes the subsequent focus() observable.
        await this.revealLeafCompat(view.leaf);

        // replaceSelection()/caret APIs are only reliable in source mode.
        const state = view.leaf.getViewState();
        if (state.state?.mode !== "source") {
            state.state = { ...state.state, mode: "source" };
            await view.leaf.setViewState(state, { focus: true });
            await sleep(10);
        }

        view.editor.focus();

        // Reveal/refocus can drop the caret association; re-assert it from the
        // editor's own record so Obsidian repaints and scrolls to where the
        // user was, instead of inserting at a stale or default position.
        view.editor.setCursor(view.editor.getCursor());

        // The protocol handler can run while a different window has OS focus.
        // Electron honours window.focus() here.
        window.focus();
    }

    async handleInsertAtCursor(parameters: Parameters) {
        let view = this.app.workspace.getActiveViewOfType(MarkdownView);

        if (parameters.filepath) {
            const file = this.app.vault.getAbstractFileByPath(
                parameters.filepath
            );
            if (file instanceof TFile && (!view || view.file?.path !== file.path)) {
                await this.plugin.open({
                    file,
                    setting: this.plugin.settings
                        .openFileWithoutWriteInNewPane,
                    parameters: parameters,
                });
                await sleep(150);
                view = this.app.workspace.getActiveViewOfType(MarkdownView);
            }
        } else {
            // No filepath: target whatever the user is looking at, falling back
            // to the last used markdown leaf rather than silently doing nothing.
            view = this.resolveInsertionTarget();
        }

        let text = parameters.insertatcursor;
        if (text.includes(CLIPBOARD_TOKEN)) {
            let clipboard: string;
            try {
                clipboard = await navigator.clipboard.readText();
            } catch {
                // Deliberate abort: inserting the unexpanded token (or a
                // partially built string) would corrupt the note, so nothing is
                // written at all.
                new Notice("Could not read the clipboard");
                this.plugin.failure(parameters);
                return;
            }
            text = text.split(CLIPBOARD_TOKEN).join(clipboard);
        }

        if (!view) {
            // No editor anywhere. The policy comes from the settings: report it and write nothing, or
            // fall back to today's daily note, which needs no editor at all.
            const fallback = String(parameters.insertfallback || (this.plugin.settings.insertFallback === "daily" ? "daily" : "notice")).toLowerCase();
            if (fallback === "daily") {
                const now = new Date();
                const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
                new Notice(`No active editor — appended to ${stamp} instead`);
                await this.handleWrite({ filepath: stamp, data: text, mode: "append", separator: "" } as unknown as Parameters);
                this.plugin.success(parameters);
                return;
            }
            new Notice("No active editor to insert text into");
            this.plugin.failure(parameters);
            return;
        }

        // Read the mode before inserting so viewmode=preview can be restored
        // after the insertion has actually completed.
        const state = view.leaf.getViewState();
        await this.focusInsertionTarget(view);

        // List-aware insert. The caller sends a markdown list item such as "- [title](url)".
        // If the caret's line is already a list item (dash, star, plus or an ordered marker), drop the
        // payload's leading marker so the text continues that list rather than nesting a second one.
        // On a plain line the marker is kept, so the same URI still starts a list from scratch.
        // Where the payload lands when the caret's line already has content:
        //   insertline=after (default) — a new sibling item at the line's own depth;
        //   insertline=under           — nested one level beneath the line.
        // Either way the payload's following lines go one level deeper than its first line, so a
        // multi-link send becomes a parent item with children rather than a flat run.
        const caret = view.editor.getCursor();
        const caretLine = view.editor.getLine(caret.line) || "";
        const listMatch = caretLine.match(/^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/);
        const payloadIsListItem = /^[-*+] /.test(text);
        // insertline= wins when present; otherwise the plugin setting decides.
        const insertUnder = String(parameters.insertline || (this.plugin.settings.insertUnder ? "under" : "after")).toLowerCase() === "under";
        if (payloadIsListItem && listMatch && !listMatch[4].trim()) {
            // Empty list item: fill it in rather than nesting a second marker.
            text = text.slice(2);
        } else if (payloadIsListItem && caretLine.trim()) {
            // Something is already written on this line, so the payload goes after all of it and the
            // existing text keeps its place and its depth.
            const base = (listMatch ? listMatch[1] : "") + (insertUnder ? "\t" : "");
            const markerChar = listMatch ? (/^\d/.test(listMatch[2]) ? "1." : listMatch[2]) : "";
            const raw = text.slice(listMatch ? 2 : 0).split("\n");
            // Rebase: drop whatever common indentation the payload already carries, so its own
            // structure is preserved and each of its following lines ends up exactly one level
            // deeper than the first instead of two.
            const tail = raw.slice(1).filter(line => line.trim().length);
            const common = tail.length ? Math.min(...tail.map(line => (line.match(/^[ \t]*/) || [""])[0].length)) : 0;
            const body = [raw[0]].concat(raw.slice(1).map(line => (line.length ? line.slice(common) : line)));
            const head = (markerChar ? markerChar + " " : "") + body[0];
            const rest = body.slice(1).map(line => (line.length ? base + "\t" + line : line));
            text = "\n" + base + head + (rest.length ? "\n" + rest.join("\n") : "");
            view.editor.setCursor({ line: caret.line, ch: caretLine.length });
        }

        view.editor.replaceSelection(text);
        const cursor = view.editor.getCursor();
        view.editor.scrollIntoView({ from: cursor, to: cursor }, true);

        if (parameters.viewmode === "preview") {
            state.state = { ...state.state, mode: "preview" };
            await view.leaf.setViewState(state);
        }

        await sleep(10);
        this.plugin.success(parameters);
    }

    async handleWrite(
        parameters: Parameters,
        createdDailyNote: boolean = false
    ) {
        let file: TAbstractFile | null;
        if (parameters.filepath) {
            file = this.app.vault.getAbstractFileByPath(parameters.filepath);
        } else {
            file = this.app.workspace.getActiveFile();
        }

        if (parameters.filepath || file) {
            let outFile: TFile;
            let path = parameters.filepath ?? file.path;
            if (parameters.mode === "overwrite") {
                outFile = await this.plugin.writeAndOpenFile(
                    path,
                    parameters.data,
                    parameters
                );
                this.plugin.success(parameters);
            } else if (parameters.mode === "prepend") {
                if (file instanceof TFile) {
                    outFile = await this.plugin.prepend(file, parameters);
                } else {
                    outFile = await this.plugin.prepend(path, parameters);
                }
                this.plugin.success(parameters);
            } else if (parameters.mode === "append") {
                if (file instanceof TFile) {
                    outFile = await this.plugin.append(file, parameters);
                } else {
                    outFile = await this.plugin.append(path, parameters);
                }
                this.plugin.success(parameters);
            } else if (parameters.mode === "new") {
                if (file instanceof TFile) {
                    outFile = await this.plugin.writeAndOpenFile(
                        getAlternativeFilePath(this.app, file),
                        parameters.data,
                        parameters
                    );
                    await this.plugin.hookSuccess(parameters, outFile);
                } else {
                    outFile = await this.plugin.writeAndOpenFile(
                        path,
                        parameters.data,
                        parameters
                    );
                    await this.plugin.hookSuccess(parameters, outFile);
                }
            } else if (!createdDailyNote && file instanceof TFile) {
                new Notice("File already exists");
                await this.plugin.openExistingFileAndSetCursor(
                    file.path,
                    parameters
                );
                this.plugin.failure(parameters);
            } else {
                outFile = await this.plugin.writeAndOpenFile(
                    path,
                    parameters.data,
                    parameters
                );
                this.plugin.success(parameters);
            }
            if (parameters.uid) {
                await this.tools.writeUIDToFile(outFile, parameters.uid);
            }
        } else {
            new Notice("Cannot find file");
            this.plugin.failure(parameters);
        }
    }

    async handleOpen(parameters: Parameters) {
        if (parameters.heading != undefined) {
            let suffix = "";
            if (!parameters.mode) {
                // If mode is specified we set the cursor ourself in `setCursor`
                // and prevent the highlighting
                suffix = "#" + parameters.heading;
            }
            await this.plugin.open({
                file: parameters.filepath + suffix,
                setting: this.plugin.settings.openFileWithoutWriteInNewPane,
                parameters: parameters,
            });
        } else if (parameters.block != undefined) {
            await this.plugin.open({
                file: parameters.filepath + "#^" + parameters.block,
                setting: this.plugin.settings.openFileWithoutWriteInNewPane,
                parameters: parameters,
            });
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view) return;
            const cache = this.app.metadataCache.getFileCache(view.file);
            const block = cache.blocks[parameters.block.toLowerCase()];
            view.editor.focus();
            if (block) {
                view.editor.setCursor({
                    line: block.position.start.line,
                    ch: 0,
                });
            }
        } else {
            await this.plugin.open({
                file: parameters.filepath,
                setting: this.plugin.settings.openFileWithoutWriteInNewPane,
                parameters: parameters,
            });
            if (
                parameters.line != undefined ||
                parameters.column != undefined ||
                parameters.offset != undefined
            ) {
                await this.plugin.setCursorInLine(parameters);
            }
        }
        if (parameters.mode != undefined || parameters.heading) {
            await this.plugin.setCursor(parameters);
        }
        if (parameters.uid) {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);

            await this.tools.writeUIDToFile(view.file, parameters.uid);
        }
        this.plugin.success(parameters);
    }

    async handleOpenBlock(parameters: Parameters) {
        const file = this.tools.getFileFromBlockID(parameters.block);
        if (file) {
            await this.plugin.chooseHandler(
                {
                    ...parameters,
                    filepath: file.path,
                },
                false
            );
        }
    }

    async handleCopyFileURI(
        withoutData: boolean,
        withFormat: boolean,
        file?: TFile
    ): Promise<void> {
        const view = this.app.workspace.getActiveViewOfType(FileView);
        if (!view && !file) return;
        file = file ?? view.file;
        if (view instanceof MarkdownView) {
            const pos = view.editor.getCursor();
            const cache = this.app.metadataCache.getFileCache(view.file);
            if (cache.headings) {
                for (const heading of cache.headings) {
                    if (
                        heading.position.start.line <= pos.line &&
                        heading.position.end.line >= pos.line
                    ) {
                        await this.tools.copyURI(
                            {
                                filepath: view.file.path,
                                heading: heading.heading,
                            },
                            withFormat,
                            file
                        );
                        return;
                    }
                }
            }
            if (cache.blocks) {
                for (const blockID of Object.keys(cache.blocks)) {
                    const block = cache.blocks[blockID];
                    if (
                        block.position.start.line <= pos.line &&
                        block.position.end.line >= pos.line
                    ) {
                        await this.tools.copyURI(
                            {
                                filepath: view.file.path,
                                block: block.id,
                            },
                            withFormat,
                            file
                        );
                        return;
                    }
                }
            }
        }

        if (withoutData) {
            const file2 = file ?? this.app.workspace.getActiveFile();
            if (!file2) {
                new Notice("No file opened");
                return;
            }
            await this.tools.copyURI(
                {
                    filepath: file2.path,
                },
                withFormat,
                file
            );
        } else {
            const fileModal = new FileModal(
                this.plugin,
                "Choose a file",
                false
            );
            fileModal.open();
            fileModal.onChooseItem = (item, _) => {
                new EnterDataModal(this.plugin, withFormat, item.source).open();
            };
        }
    }

    handleOpenSettings(parameters: Parameters) {
        if (this.app.setting.containerEl.parentElement === null) {
            this.app.setting.open();
        }
        if (parameters.settingid == "plugin-browser") {
            this.app.setting.openTabById("community-plugins");
            this.app.setting.activeTab.containerEl.find(".mod-cta").click();
        } else if (parameters.settingid == "theme-browser") {
            this.app.setting.openTabById("appearance");
            this.app.setting.activeTab.containerEl.find(".mod-cta").click();
        } else {
            this.app.setting.openTabById(parameters.settingid);
        }

        if (parameters.settingsection) {
            const elements = Array.from(
                this.app.setting.tabContentContainer.querySelectorAll("*")
            );
            const heading = elements.find(
                (e) => e.textContent == parameters.settingsection
            );

            if (heading) {
                heading.scrollIntoView();
            }
        }
        this.plugin.success(parameters);
    }

    async handleUpdatePlugins(parameters: Parameters) {
        new Notice("Checking for updates…");
        await this.app.plugins.checkForUpdates();

        const updateCount = Object.keys(this.app.plugins.updates).length;
        if (updateCount > 0) {
            parameters.settingid = "community-plugins";
            this.handleOpenSettings(parameters);
            this.app.setting.activeTab.containerEl
                .findAll(".mod-cta")
                .last()
                .click();
        }
        this.plugin.success(parameters);
    }

    async handleBookmarks(parameters: Parameters) {
        const bookmarksPlugin =
            this.app.internalPlugins.getEnabledPluginById("bookmarks");
        const bookmarks = bookmarksPlugin.getBookmarks();
        const bookmark = bookmarks.find((b) => b.title == parameters.bookmark);
        let openMode;
        if (parameters.openmode == "true" || parameters.openmode == "false") {
            openMode = parameters.openmode == "true";
        } else {
            openMode = parameters.openmode;
        }
        bookmarksPlugin.openBookmark(bookmark, openMode);
    }

    async handleCanvas(parameters: Parameters) {
        if (parameters.filepath) {
            await this.plugin.open({
                file: parameters.filepath,
                setting: this.plugin.settings.openFileWithoutWriteInNewPane,
                parameters: parameters,
            });
        }
        const activeView = this.app.workspace.activeLeaf?.view;
        if (!activeView) {
            new Notice("No active view");
            return;
        }
        if (activeView.getViewType() != "canvas") {
            new Notice("Active view is not a canvas");
            return;
        }
        const canvasView = activeView as CanvasView;
        if (parameters.canvasnodes) {
            const ids = parameters.canvasnodes.split(",");
            const nodes = canvasView.canvas.nodes;
            const selectedNodes = ids.map((id) => nodes.get(id));
            const selection = canvasView.canvas.selection;

            canvasView.canvas.updateSelection(() => {
                for (const node of selectedNodes) {
                    selection.add(node);
                }
            });

            canvasView.canvas.zoomToSelection();
        }
        if (parameters.canvasviewport) {
            const [x, y, zoom] = parameters.canvasviewport.split(",");
            if (x != "-") {
                if (x.startsWith("--") || x.startsWith("++")) {
                    const tx = canvasView.canvas.tx + Number(x.substring(1));
                    canvasView.canvas.tx = tx;
                } else {
                    canvasView.canvas.tx = Number(x);
                }
            }
            if (y != "-") {
                if (y.startsWith("--") || y.startsWith("++")) {
                    const ty = canvasView.canvas.ty + Number(y.substring(1));
                    canvasView.canvas.ty = ty;
                } else {
                    canvasView.canvas.ty = Number(y);
                }
            }
            if (zoom != "-") {
                if (zoom.startsWith("--") || zoom.startsWith("++")) {
                    const tZoom =
                        canvasView.canvas.tZoom + Number(zoom.substring(1));
                    canvasView.canvas.tZoom = tZoom;
                } else {
                    canvasView.canvas.tZoom = Number(zoom);
                }
            }
            canvasView.canvas.markViewportChanged();
        }
    }
}
