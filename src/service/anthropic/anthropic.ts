import * as vscode from "vscode";
import { asyncIterator } from "../asyncIterator";
import { AIProvider, GetInteractionSettings } from "../base";
import { InteractionSettings, Settings } from "../../types/Settings";
import { loggingProvider } from "../../providers/loggingProvider";
import { eventEmitter } from "../../events/eventEmitter";
import { ClaudeModel } from "./models/claude";
import { AnthropicMessage, AnthropicRequest } from "./types/ClaudeRequest";
import {
	AnthropicResponse,
	AnthropicResponseStreamContent,
	AnthropicResponseStreamDelta,
	AnthropicStreamResponse,
} from "./types/ClaudeResponse";
import { AnthropicModel } from "../../types/Models";

export class Anthropic implements AIProvider {
	decoder = new TextDecoder();
	settings: Settings["anthropic"];
	chatHistory: AnthropicMessage[] = [];
	chatModel: AnthropicModel | undefined;
	codeModel: AnthropicModel | undefined;
	interactionSettings: InteractionSettings | undefined;

	constructor() {
		const config = vscode.workspace.getConfiguration("Wingman");

		const anthropicConfig = config.get<Settings["anthropic"]>("Anthropic");

		if (!anthropicConfig) {
			this.handleError("Unable to load Anthropic settings.");
			return;
		}

		loggingProvider.logInfo(
			`Anthropic settings loaded: ${JSON.stringify(anthropicConfig)}`
		);

		this.settings = anthropicConfig;

		this.chatModel = this.getChatModel(this.settings.chatModel);
		this.codeModel = this.getCodeModel(this.settings.codeModel);

		this.interactionSettings = GetInteractionSettings();
	}

	private handleError(message: string) {
		vscode.window.showErrorMessage(message);
		loggingProvider.logError(message);
		eventEmitter._onFatalError.fire();
	}

	private getCodeModel(codeModel: string): AnthropicModel | undefined {
		switch (true) {
			case codeModel.startsWith("claude"):
				return new ClaudeModel();
			default:
				this.handleError(
					"Invalid code model name, currently code supports Claude 3 model(s)."
				);
		}
	}

	private getChatModel(chatModel: string): AnthropicModel | undefined {
		switch (true) {
			case chatModel.startsWith("claude"):
				return new ClaudeModel();
			default:
				this.handleError(
					"Invalid chat model name, currently chat supports Claude 3 model(s)."
				);
		}
	}

	private async fetchModelResponse(
		payload: AnthropicRequest,
		signal: AbortSignal
	) {
		if (signal.aborted) {
			return undefined;
		}
		return fetch(new URL(`${this.settings?.baseUrl}/messages`), {
			method: "POST",
			body: JSON.stringify(payload),
			headers: {
				"Content-Type": "application/json",
				"x-api-key": this.settings?.apiKey!,
				"anthropic-version": "2023-06-01",
			},
			signal,
		});
	}

	async *generate(payload: AnthropicRequest, signal: AbortSignal) {
		const startTime = new Date().getTime();
		let response: Response | undefined;

		try {
			response = await this.fetchModelResponse(payload, signal);
		} catch (error) {
			loggingProvider.logError(
				`Anthropic chat request with model: ${payload.model} failed with the following error: ${error}`
			);
		}

		if (!response?.ok) {
			loggingProvider.logError(
				`Anthropic - Chat failed with the following status code: ${response?.status}`
			);
			vscode.window.showErrorMessage(
				`Anthropic - Chat failed with the following status code: ${response?.status}`
			);
		}

		if (!response?.body) {
			return "";
		}

		const endTime = new Date().getTime();
		const executionTime = (endTime - startTime) / 1000;

		loggingProvider.logInfo(
			`Anthropic - Chat Time To First Token execution time: ${executionTime} seconds`
		);

		let currentMessage = "";
		for await (const chunk of asyncIterator(response.body)) {
			if (signal.aborted) {
				return "";
			}

			const decodedValue = this.decoder.decode(chunk);

			currentMessage += decodedValue;

			const eventEndIndex = currentMessage.indexOf("\n\n");
			if (eventEndIndex !== -1) {
				// Extract the event data
				const eventData = currentMessage.substring(0, eventEndIndex);

				// Remove the event data from currentMessage
				currentMessage = currentMessage.substring(eventEndIndex + 2);

				// Remove the "data: " prefix and parse the JSON
				const jsonStr = eventData.replace(/^data: /, "");
				const parsedData = JSON.parse(
					jsonStr
				) as AnthropicStreamResponse;

				switch (parsedData.type) {
					case "content_block_start":
						const blockStart =
							parsedData as unknown as AnthropicResponseStreamContent;

						break;
					case "content_block_delta":
						const blockDelta =
							parsedData as unknown as AnthropicResponseStreamDelta;
						break;
					default:
						// Handle unknown event type
						break;
				}

				yield parsedData;
			}
		}
	}

	public async codeComplete(
		beginning: string,
		ending: string,
		signal: AbortSignal,
		additionalContext?: string
	): Promise<string> {
		const startTime = new Date().getTime();

		const prompt = this.codeModel!.CodeCompletionPrompt.replace(
			"{beginning}",
			beginning
		).replace("{ending}", ending);

		const codeRequestOptions: AnthropicRequest = {
			model: this.settings?.codeModel!,
			messages: [
				{
					role: "user",
					content: `The following are all the types available. Use these types while considering how to complete the code provided. Do not repeat or use these types in your answer.

${additionalContext ?? ""}

-----

${prompt}`,
				},
			],
			temperature: 0.4,
			top_p: 0.3,
			top_k: 40,
			max_tokens: this.interactionSettings?.codeMaxTokens || 4096,
		};

		loggingProvider.logInfo(
			`Anthropic - Code Completion submitting request with body: ${JSON.stringify(
				codeRequestOptions
			)}`
		);

		let response: Response | undefined;

		try {
			response = await this.fetchModelResponse(
				codeRequestOptions,
				signal
			);
		} catch (error) {
			loggingProvider.logError(
				`Anthropic - code completion request with model ${this.settings?.codeModel} failed with the following error: ${error}`
			);
		}

		const endTime = new Date().getTime();
		const executionTime = (endTime - startTime) / 1000;

		loggingProvider.logInfo(
			`Anthropic - Code Completion execution time: ${executionTime} seconds`
		);

		if (!response?.ok) {
			loggingProvider.logError(
				`Anthropic - Code Completion failed with the following status code: ${response?.status}`
			);
			vscode.window.showErrorMessage(
				`Anthropic - Code Completion failed with the following status code: ${response?.status}`
			);
		}

		if (!response?.body) {
			return "";
		}

		const AnthropicResponse = (await response.json()) as AnthropicResponse;
		return AnthropicResponse.content[0].text;
	}

	public clearChatHistory(): void {
		this.chatHistory = [];
	}

	public async *chat(
		prompt: string,
		ragContent: string,
		signal: AbortSignal
	) {
		let systemPrompt = this.chatModel!.ChatPrompt;

		if (ragContent) {
			systemPrompt += `Here's some additional information that may help you generate a more accurate response.
Please determine if this information is relevant and can be used to supplement your response: 
${ragContent}
---------------
`;
		}

		systemPrompt += `\n${prompt}`;

		this.chatHistory.push({
			role: "user",
			content: systemPrompt,
		});

		const messages: AnthropicMessage[] = [];

		if (this.chatHistory.length > 0) {
			messages.push(...this.truncateChatHistory());
		}

		const chatPayload: AnthropicRequest = {
			model: this.settings?.chatModel!,
			messages: this.truncateChatHistory(),
			stream: true,
			temperature: 0.8,
			max_tokens: this.interactionSettings?.chatMaxTokens || 4096,
		};

		loggingProvider.logInfo(
			`Anthropic - Chat submitting request with body: ${JSON.stringify(
				chatPayload
			)}`
		);

		this.clearChatHistory();

		let completeMessage = "";
		for await (const chunk of this.generate(chatPayload, signal)) {
			// if (!chunk?.choices) {
			// 	continue;
			// }

			// const { content } = chunk.choices[0].delta;
			// if (!content) {
			// 	continue;
			// }

			// completeMessage += content;
			yield "";
		}

		this.chatHistory = this.chatHistory.concat({
			role: "assistant",
			content: completeMessage,
		});
	}

	public async genCodeDocs(
		prompt: string,
		ragContent: string,
		signal: AbortSignal
	): Promise<string> {
		if (!this.chatModel?.genDocPrompt) return "";

		const startTime = new Date().getTime();
		const genDocPrompt =
			"Generate documentation for the following code:\n" + prompt;

		let systemPrompt = this.chatModel?.genDocPrompt;

		if (ragContent) {
			systemPrompt += ragContent;
		}

		systemPrompt += `\n\n${genDocPrompt}`;
		systemPrompt = systemPrompt.replace(/\t/, "");

		const genDocsPayload: AnthropicRequest = {
			model: this.settings?.chatModel!,
			messages: [
				{
					role: "user",
					content: systemPrompt,
				},
			],
			temperature: 0.4,
			top_p: 0.3,
			max_tokens: this.interactionSettings?.chatMaxTokens || 4096,
		};

		let response: Response | undefined;
		try {
			response = await this.fetchModelResponse(genDocsPayload, signal);
		} catch (error) {
			loggingProvider.logError(
				`Anthropic - Gen Docs request with model ${this.settings?.codeModel} failed with the following error: ${error}`
			);
		}

		const endTime = new Date().getTime();
		const executionTime = (endTime - startTime) / 1000;

		loggingProvider.logInfo(
			`Anthropic - Gen Docs execution time: ${executionTime} seconds`
		);

		if (!response?.ok) {
			loggingProvider.logError(
				`Anthropic - Gen Docs failed with the following status code: ${response?.status}`
			);
			vscode.window.showErrorMessage(
				`Anthropic - Gen Docs failed with the following status code: ${response?.status}`
			);
		}

		if (!response?.body) {
			return "";
		}

		const AnthropicResponse = (await response.json()) as AnthropicResponse;
		return AnthropicResponse.content[0].text;
	}

	private truncateChatHistory(maxRecords: number = 2) {
		if (this.chatHistory.length > maxRecords) {
			this.chatHistory.splice(0, this.chatHistory.length - maxRecords);
		}
		return this.chatHistory;
	}

	public async refactor(
		prompt: string,
		ragContent: string,
		signal: AbortSignal
	): Promise<string> {
		if (!this.chatModel?.refactorPrompt) return "";

		const startTime = new Date().getTime();

		let systemPrompt = this.chatModel?.refactorPrompt;

		if (ragContent) {
			systemPrompt += ragContent;
		}

		systemPrompt += `\n\n${prompt}`;

		const refactorPayload: AnthropicRequest = {
			model: this.settings?.chatModel!,
			messages: [
				{
					role: "user",
					content: systemPrompt,
				},
			],
			temperature: 0.4,
			top_p: 0.3,
			top_k: 40,
			max_tokens: this.interactionSettings?.chatMaxTokens || 4096,
		};

		let response: Response | undefined;
		try {
			response = await this.fetchModelResponse(refactorPayload, signal);
		} catch (error) {
			loggingProvider.logError(
				`Anthropic - Refactor request with model ${this.settings?.codeModel} failed with the following error: ${error}`
			);
		}

		const endTime = new Date().getTime();
		const executionTime = (endTime - startTime) / 1000;

		loggingProvider.logInfo(
			`Anthropic - Refactor execution time: ${executionTime} seconds`
		);

		if (!response?.ok) {
			loggingProvider.logError(
				`Anthropic - Refactor failed with the following status code: ${response?.status}`
			);
			vscode.window.showErrorMessage(
				`Anthropic - Refactor failed with the following status code: ${response?.status}`
			);
		}

		if (!response?.body) {
			return "";
		}

		const AnthropicResponse = (await response.json()) as AnthropicResponse;
		return AnthropicResponse.content[0].text;
	}
}
