import * as vscode from "vscode";
import fs from "node:fs";
import { eventEmitter } from "../events/eventEmitter";
import { AIProvider } from "../service/base";
import {
	AppMessage,
	CodeContext,
	CodeContextDetails,
	FileMetadata,
} from "@shared/types/Message";
import {
	IndexFilter,
	InteractionSettings,
} from "../../shared/src/types/Settings";
import { loggingProvider } from "./loggingProvider";
import {
	extractCodeBlock,
	getNonce,
	getSymbolsFromOpenFiles,
} from "./utilities";
import { LSPClient } from "../client";
import {
	ComposerRequest,
	DiffViewCommand,
	FileSearchResult,
} from "@shared/types/Composer";
import { DiffViewProvider } from "./diffViewProvider";

let abortController = new AbortController();

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "wing-man-chat-view";

	private _disposables: vscode.Disposable[] = [];

	constructor(
		private readonly _lspClient: LSPClient,
		private readonly _aiProvider: AIProvider,
		private readonly _context: vscode.ExtensionContext,
		private readonly _interactionSettings: InteractionSettings,
		private readonly _diffViewProvider: DiffViewProvider
	) {}

	dispose() {
		this._disposables.forEach((d) => d.dispose());
		this._disposables = [];
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		token: vscode.CancellationToken
	) {
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this._context.extensionUri,
				vscode.Uri.joinPath(
					this._context.extensionUri,
					"node_modules/vscode-codicons"
				),
			],
		};

		webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

		this._lspClient.setComposerWebViewReference(webviewView.webview);

		token.onCancellationRequested((e) => {
			abortController.abort();
			eventEmitter._onQueryComplete.fire();
		});

		this._disposables.push(
			webviewView.webview.onDidReceiveMessage(
				async (data: AppMessage) => {
					if (!data) {
						return;
					}

					const { command, value } = data;

					switch (command) {
						case "diff-view":
							const { file, diff } = value as DiffViewCommand;
							this._diffViewProvider.createDiffView({
								file,
								diff: extractCodeBlock(diff),
							});
							break;
						case "clear-chat-history":
							this._aiProvider.clearChatHistory();
							await this._lspClient.clearChatHistory();
							break;
						case "terminal":
							// Use value to spawn new terminal with command
							const terminalCommand = value as string;
							const terminal = vscode.window.createTerminal({
								name: "Wingman Command",
							});
							terminal.show();
							terminal.sendText(terminalCommand);
							break;
						case "mergeIntoFile":
							const { file: artifactFile, code: markdown } =
								value as FileMetadata;
							let code = markdown?.startsWith("```")
								? extractCodeBlock(markdown)
								: markdown;
							const relativeFilePath =
								vscode.workspace.asRelativePath(artifactFile);

							// Get the workspace folder URI
							const workspaceFolder =
								vscode.workspace.workspaceFolders?.[0].uri;
							if (!workspaceFolder) {
								throw new Error("No workspace folder found");
							}

							// Construct the full URI of the file
							const fileUri = vscode.Uri.joinPath(
								workspaceFolder,
								relativeFilePath
							);

							try {
								// Check if the file exists
								await vscode.workspace.fs.stat(fileUri);

								// Check if the document is already open
								let document =
									vscode.workspace.textDocuments.find(
										(doc) =>
											doc.uri.toString() ===
											fileUri.toString()
									);
								if (!document) {
									// Open the text document if it is not already open
									document =
										await vscode.workspace.openTextDocument(
											fileUri
										);
								}

								// Replace text in the document
								await this.replaceTextInDocument(
									document,
									extractCodeBlock(code!)
								);
							} catch (error) {
								if (
									(error as vscode.FileSystemError).code ===
									"FileNotFound"
								) {
									// Create the text document if it does not exist
									await vscode.workspace.fs.writeFile(
										fileUri,
										new Uint8Array()
									);
									const document =
										await vscode.workspace.openTextDocument(
											fileUri
										);
									await this.replaceTextInDocument(
										document,
										extractCodeBlock(code!)
									);
								} else {
									throw error;
								}
							}
							break;
						case "get-files":
							const searchTerm = value as string | undefined;
							if (!searchTerm || searchTerm?.length === 0) {
								return [];
							}
							// Find all files in the workspace, excluding node_modules
							const allFiles = await vscode.workspace.findFiles(
								"**/*",
								"**/node_modules/**"
							);

							// Filter files based on the file name
							const filteredFiles = allFiles.filter((file) => {
								const fileName =
									vscode.workspace.asRelativePath(file.path);
								return (
									fileName &&
									fileName.toLowerCase().includes(searchTerm)
								);
							});

							webviewView.webview.postMessage({
								command: "get-files-result",
								value: filteredFiles.slice(0, 10).map(
									(result) =>
										({
											file: vscode.workspace
												.asRelativePath(result)
												.split("/")
												.pop()!,
											path: result.fsPath,
										} satisfies FileSearchResult)
								),
							});
							break;
						case "compose":
							await this._lspClient.compose(
								value as ComposerRequest
							);
							break;
						case "delete-index":
							await this._lspClient.deleteIndex();
							break;
						case "build-index":
							const { filter, exclusionFilter } =
								value as IndexFilter;
							this._context.workspaceState.update(
								"index-filter",
								filter
							);
							this._context.workspaceState.update(
								"exclusion-filter",
								exclusionFilter
							);
							await this._lspClient.buildFullIndex(
								filter,
								exclusionFilter
							);
							break;
						case "check-index":
							webviewView.webview.postMessage({
								command: "index-status",
								value: await this._lspClient.indexExists(),
							});
							break;
						case "chat": {
							this.handleChatMessage({ value, webviewView });
							break;
						}
						case "cancel": {
							abortController.abort();
							break;
						}
						case "clipboard": {
							vscode.env.clipboard.writeText(value as string);
							break;
						}
						case "copyToFile": {
							this.sendContentToNewDocument(value as string);
							break;
						}
						case "clear": {
							this._aiProvider.clearChatHistory();
							break;
						}
						case "showContext": {
							const { fileName, lineRange } =
								value as CodeContext;
							const [start, end] = lineRange
								.split("-")
								.map(Number);
							const uri = vscode.Uri.file(fileName);
							vscode.window.showTextDocument(uri).then(() => {
								if (!vscode.window.activeTextEditor) {
									return;
								}

								vscode.window.activeTextEditor.selection =
									new vscode.Selection(
										new vscode.Position(start, 0),
										new vscode.Position(end, 0)
									);
							});
							break;
						}
						case "ready": {
							const appState = {
								workspaceFolder: getActiveWorkspace(),
								theme: vscode.window.activeColorTheme.kind,
								indexFilter:
									this._context.workspaceState.get(
										"index-filter"
									),
							};
							webviewView.webview.postMessage({
								command: "init",
								value: appState,
							});
							break;
						}
						case "log": {
							this.log(value);
							break;
						}
					}
				}
			),
			vscode.window.onDidChangeActiveColorTheme(
				(theme: vscode.ColorTheme) => {
					webviewView.webview.postMessage({
						command: "setTheme",
						value: theme.kind,
					});
				}
			)
		);
	}

	async replaceTextInDocument(
		document: vscode.TextDocument,
		newText: string
	) {
		// Show the document in an editor
		const editor = await vscode.window.showTextDocument(document);

		// Create a range for the entire document
		const startPosition = new vscode.Position(0, 0);
		const endPosition = new vscode.Position(
			document.lineCount - 1,
			document.lineAt(document.lineCount - 1).text.length
		);
		const range = new vscode.Range(startPosition, endPosition);

		// Apply the edit to replace the entire content
		await editor.edit((editBuilder) => {
			editBuilder.replace(range, newText);
		});
	}

	private async sendContentToNewDocument(content: string) {
		const newFile = await vscode.workspace.openTextDocument({
			content,
		});
		vscode.window.showTextDocument(newFile);
	}

	private async handleChatMessage({
		value,
		webviewView,
	}: Pick<AppMessage, "value"> & { webviewView: vscode.WebviewView }) {
		abortController = new AbortController();

		await this.streamChatResponse(
			value as string,
			getChatContext(this._interactionSettings.chatContextWindow),
			webviewView
		);
	}

	private async streamChatResponse(
		prompt: string,
		context: CodeContextDetails | undefined,
		webviewView: vscode.WebviewView
	) {
		let ragContext = "";

		const { codeDocs, projectDetails } =
			await this._lspClient.getEmbeddings(prompt);

		const symbols = await getSymbolsFromOpenFiles();

		ragContext = `{LANGUAGE_TEMPLATE}
{FILE_TEMPLATE}

{PROJECT_TEMPLATE}

{CONTEXT_TEMPLATE}

{SYMBOLS_TEMPLATE}

{CURRENT_LINE_TEMPLATE}`;

		ragContext = ragContext.replace(
			"{LANGUAGE_TEMPLATE}",
			!context?.language
				? ""
				: `The user is seeking coding advice using ${context?.language}.`
		);

		ragContext = ragContext.replace(
			"{FILE_TEMPLATE}",
			!context?.fileName
				? ""
				: `The user is currently working on the file: ${context?.fileName}`
		);

		ragContext = ragContext.replace(
			"{SYMBOLS_TEMPLATE}",
			!context?.text
				? ""
				: `The following code snippet is provided for context:

${context?.text}

=======`
		);

		ragContext = ragContext.replace(
			"{CURRENT_LINE_TEMPLATE}",
			!context?.currentLine
				? ""
				: `The user is currently working on the following line: ${context?.currentLine}`
		);

		if (projectDetails) {
			ragContext = ragContext.replace(
				"{PROJECT_TEMPLATE}",
				`Here are the project details for reference:
${projectDetails}

=======`
			);
		}

		if (codeDocs.length === 0) {
			ragContext = ragContext.replace(
				"{CONTEXT_TEMPLATE}",
				`Here are the available types reference by the code in context to use as a reference when answering questions, these may not be related to the code provided:

${symbols}

=======`
			);
		} else {
			ragContext = ragContext.replace(
				"{CONTEXT_TEMPLATE}",
				`Here are the available types to use as a reference when answering questions, these may not be related to the code provided:

${codeDocs.join("\n----\n")}

=======`
			);
		}

		if (context) {
			const { fileName, lineRange, workspaceName } = context;
			webviewView.webview.postMessage({
				command: "context",
				value: {
					fileName,
					lineRange,
					workspaceName,
				} satisfies CodeContext,
			});
		}

		eventEmitter._onQueryStart.fire();

		const response = this._aiProvider.chat(
			prompt,
			ragContext,
			abortController.signal
		);

		for await (const chunk of response) {
			webviewView.webview.postMessage({
				command: "response",
				value: chunk,
			});
		}

		eventEmitter._onQueryComplete.fire();

		webviewView.webview.postMessage({
			command: "done",
			value: null,
		});
	}

	private getHtmlForWebview(webview: vscode.Webview) {
		const htmlUri = webview.asWebviewUri(
			vscode.Uri.joinPath(
				this._context.extensionUri,
				"out",
				"views",
				"chat.html"
			)
		);

		const nonce = getNonce();

		const htmlContent = fs.readFileSync(htmlUri.path, "utf8");

		// Replace placeholders in the HTML content
		const finalHtmlContent = htmlContent.replace(
			/CSP_NONCE_PLACEHOLDER/g,
			nonce
		);

		const prefix = webview.asWebviewUri(
			vscode.Uri.joinPath(this._context.extensionUri, "out", "views")
		);
		const srcHrefRegex = /(src|href)="([^"]+)"/g;

		// Replace the matched filename with the prefixed filename
		const updatedHtmlContent = finalHtmlContent.replace(
			srcHrefRegex,
			(match, attribute, filename) => {
				const prefixedFilename = `${prefix}${filename}`;
				return `${attribute}="${prefixedFilename}"`;
			}
		);

		return addNoneAttributeToLink(updatedHtmlContent, nonce);
	}

	private log = (value: unknown) => {
		loggingProvider.logInfo(JSON.stringify(value ?? ""));
	};
}

function addNoneAttributeToLink(htmlString: string, noneValue: string) {
	// Regular expression to match the link tag
	const linkRegex =
		/<link\s+(?:[^>]*?\s+)?href=["']https:\/\/file%2B\.vscode-resource\.vscode-cdn\.net\/[^"']*\.css["'][^>]*>/i;

	// Function to add the none attribute
	const addNoneAttribute = (match: string) => {
		if (match.includes("nonce=")) {
			// If none attribute already exists, return the original match
			return match;
		} else {
			// Add none attribute before the closing angle bracket
			return match.replace(/>$/, ` nonce="${noneValue}">`);
		}
	};

	// Replace the matched link tag with the modified version
	return htmlString.replace(linkRegex, addNoneAttribute);
}

function getActiveWorkspace() {
	const defaultWorkspace = "default";

	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		return (
			vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)
				?.name ?? defaultWorkspace
		);
	}

	return vscode.workspace.workspaceFolders?.[0].name ?? defaultWorkspace;
}

function getChatContext(contextWindow: number): CodeContextDetails | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return undefined;
	}

	const { document, selection } = editor;
	let codeContextRange: vscode.Range;
	let lastDirection = -1;

	if (selection && !selection.isEmpty) {
		codeContextRange = new vscode.Range(
			selection.start.line,
			selection.start.character,
			selection.end.line,
			selection.end.character
		);
	} else {
		const currentLine = selection.active.line;
		let upperLine = currentLine;
		let lowerLine = currentLine;

		const halfContext = Math.floor(contextWindow / 2);

		let upperText =
			upperLine > 0 ? document.lineAt(upperLine - 1).text : "";
		let lowerText = document.lineAt(lowerLine).text;

		// Expand context in both directions
		for (let i = 0; i < halfContext; i++) {
			if (upperLine > 0) {
				upperLine--;
				upperText = document.lineAt(upperLine).text + "\n" + upperText;
				lastDirection = 0;
			}

			if (lowerLine < document.lineCount - 1) {
				lowerLine++;
				lowerText += "\n" + document.lineAt(lowerLine).text;
				lastDirection = 1;
			}

			// Stop if we've reached the context window size
			if (upperText.length + lowerText.length >= contextWindow) {
				break;
			}
		}

		const beginningWindowLine = document.lineAt(upperLine);
		const endWindowLine = document.lineAt(lowerLine);

		codeContextRange = new vscode.Range(
			beginningWindowLine.range.start,
			endWindowLine.range.end
		);
	}

	let text = document.getText(codeContextRange);

	if (text.length > contextWindow) {
		if (lastDirection === 0) {
			text = text.substring(text.length - contextWindow, text.length);
		} else if (lastDirection === 1) {
			text = text.substring(0, contextWindow);
		}
	}

	const documentUri = vscode.Uri.file(document.fileName);
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);

	return {
		text,
		currentLine: document.lineAt(selection.active.line).text,
		lineRange: `${codeContextRange.start.line}-${codeContextRange.end.line}`,
		fileName: document.fileName,
		workspaceName: workspaceFolder?.name ?? "",
		language: document.languageId,
	};
}
