import {
	VSCodeButton,
	VSCodeTextField,
} from "@vscode/webview-ui-toolkit/react";
import { useAppContext } from "../../context";
import { vscode } from "../../utilities/vscode";
import { AppMessage } from "@shared/types/Message";
import { IndexFilter } from "@shared/types/Settings";
import { useEffect, useState } from "react";
import { Loader } from "../../Loader";

type IndexStats = {
	exists: boolean;
	processing: boolean;
	files: string[];
};

let interval: NodeJS.Timeout;

export default function Indexer() {
	const { indexFilter, exclusionFilter: savedExclusionFilter } =
		useAppContext();
	const [index, setIndex] = useState<IndexStats>({
		exists: false,
		processing: false,
		files: [],
	});
	const [filter, setFilter] = useState(
		() => indexFilter || "apps/**/*.{js,jsx,ts,tsx}"
	);
	const [exclusionFilter, setExclusionFilter] =
		useState(savedExclusionFilter);

	useEffect(() => {
		vscode.postMessage({
			command: "check-index",
		});
		interval = setInterval(() => {
			vscode.postMessage({
				command: "check-index",
			});
		}, 3000);

		return () => {
			clearInterval(interval);
		};
	}, []);

	useEffect(() => {
		window.addEventListener("message", handleResponse);

		return () => {
			window.removeEventListener("message", handleResponse);
		};
	}, []);

	const handleResponse = (event: MessageEvent<AppMessage>) => {
		const { data } = event;
		const { command } = data;

		switch (command) {
			case "index-status":
				setIndex(data.value as IndexStats);
		}
	};

	const buildIndex = () => {
		vscode.postMessage({
			command: "build-index",
			value: {
				filter,
				exclusionFilter,
			} satisfies IndexFilter,
		});
		setIndex((idx) => ({ ...idx, processing: true }));
	};

	const deleteIndex = () => {
		vscode.postMessage({
			command: "delete-index",
		});
	};

	return (
		<div className="space-y-4 mt-4">
			<p className="text-lg font-bold">
				Status:{" "}
				{index.exists
					? index.processing
						? "Processing"
						: "Ready"
					: "Not Found"}
			</p>
			<p className="text-lg">
				The indexer will breakdown your codebase to use as context in
				chat, or interactively with the code composer. It will scan your
				workspace for any filters meeting the filter criteria below. By
				default, Wingman will include your '.gitignore' file in your
				exclusion filter.
			</p>
			{!index.exists && !index.processing && (
				<section className="flex flex-col gap-4">
					<label>Inclusion Filter:</label>
					<VSCodeTextField
						value={filter}
						//@ts-expect-error
						onChange={(e) => setFilter(e.target?.value)}
					/>
					<label>Exclusion Filter: </label>
					<VSCodeTextField
						value={exclusionFilter}
						//@ts-expect-error
						onChange={(e) => setExclusionFilter(e.target?.value)}
					/>
					<VSCodeButton
						type="button"
						disabled={index.processing || !filter}
						onClick={() => buildIndex()}
					>
						Build Index
					</VSCodeButton>
				</section>
			)}
			{index.processing && (
				<p className="flex items-center">
					<Loader /> <span className="ml-2">Building Index...</span>
				</p>
			)}
			{index.exists && !index.processing && (
				<>
					<VSCodeButton
						type="button"
						onClick={() => deleteIndex()}
						className="bg-red-600"
					>
						Delete Index
					</VSCodeButton>
					<div className="mt-4">
						<p className="text-lg font-bold">Indexed Files:</p>
					</div>
					<ul>
						{index.files.map((f) => (
							<li>{f}</li>
						))}
					</ul>
				</>
			)}
		</div>
	);
}
