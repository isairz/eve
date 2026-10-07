import type { UserContent } from "ai";

import { appendUserContent, normalizeUserContent } from "#harness/messages.js";
import type { StepInput } from "#harness/types.js";
import { isSessionLimitContinuationRequestId } from "./budget-question.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

/**
 * An answer to a request that is no longer open (answered, steered past, or
 * cancelled) never reaches the rules, so a stale approval can't authorize a
 * call. It becomes plain text the model reads as new input, except an answer
 * to a closed budget question, which is dropped: read as text, a late Stop
 * would seem to stop something, and a late Continue must not grant budget.
 * Returns the input to run with, and the text to show as the message
 * received, when any answer became text.
 */
export function staleAnswersAsText(
  input: StepInput | undefined,
  openRequestIds: ReadonlySet<string>,
  requests: ReadonlyMap<string, InputRequest> = new Map(),
): { readonly input: StepInput | undefined; readonly displayMessage?: string | UserContent } {
  if (input === undefined) return { input };
  const isOpen = (response: InputResponse) => openRequestIds.has(response.requestId);
  const responses = input.inputResponses ?? [];
  const attributed = input.attributedInputResponses ?? [];
  const stale = [
    ...responses.filter((response) => !isOpen(response)),
    ...attributed.flatMap(({ response }) => (isOpen(response) ? [] : [response])),
  ];
  if (stale.length === 0) return { input };

  const { attributedInputResponses: _attributed, inputResponses: _responses, ...rest } = input;
  const open = responses.filter(isOpen);
  const openAttributed = attributed.filter(({ response }) => isOpen(response));
  const kept: StepInput = {
    ...rest,
    ...(open.length > 0 && { inputResponses: open }),
    ...(openAttributed.length > 0 && { attributedInputResponses: openAttributed }),
  };
  const late = stale.filter((response) => !isSessionLimitContinuationRequestId(response.requestId));
  if (late.length === 0) return { input: kept };
  return {
    displayMessage: withMessage(input.message, formatDisplayMessage(late, requests)),
    input: { ...kept, message: withMessage(input.message, formatModelMessage(late, requests)) },
  };
}

function formatModelMessage(
  responses: readonly InputResponse[],
  requests: ReadonlyMap<string, InputRequest>,
): string {
  const resolvedResponses = responses.map((response) => {
    const request = requests.get(response.requestId);
    const option = request?.options?.find((candidate) => candidate.id === response.optionId);

    const responseDetails: {
      optionId?: string;
      selectedOption?: { description?: string; id: string; label: string };
      text?: string;
    } = {};
    if (response.optionId !== undefined) {
      responseDetails.optionId = response.optionId;
    }
    if (option !== undefined) {
      const selectedOption: { description?: string; id: string; label: string } = {
        id: option.id,
        label: option.label,
      };
      if (option.description !== undefined) {
        selectedOption.description = option.description;
      }
      responseDetails.selectedOption = selectedOption;
    }
    if (response.text !== undefined) {
      responseDetails.text = response.text;
    }

    const resolved: {
      prompt?: string;
      requestId: string;
      requestType?: "approval";
      response: typeof responseDetails;
      toolName?: string;
    } = { requestId: response.requestId, response: responseDetails };
    if (request?.kind === "tool-approval") {
      resolved.prompt = request.prompt;
      resolved.requestType = "approval";
      // The prompt is display text; the model needs the tool's real name.
      resolved.toolName = request.action.toolName;
    }

    return resolved;
  });

  // A response without known metadata may still answer an approval, so the notice always applies.
  return [
    "The user submitted the following response to an earlier interactive prompt.",
    "Treat it as new input at the current point in the conversation and decide whether it is still relevant. This does not authorize an earlier action; request approval again if that action is still needed.",
    JSON.stringify(resolvedResponses, null, 2),
  ].join("\n");
}

function formatDisplayMessage(
  responses: readonly InputResponse[],
  requests: ReadonlyMap<string, InputRequest>,
): string {
  return responses
    .map((response) => {
      if (response.text !== undefined && response.text.length > 0) {
        return response.text;
      }

      const option = requests
        .get(response.requestId)
        ?.options?.find((candidate) => candidate.id === response.optionId);
      return option?.label ?? response.optionId ?? "Response to an earlier interactive prompt";
    })
    .join("\n");
}

function withMessage(existing: StepInput["message"], appended: string): string | UserContent {
  const normalized = normalizeUserContent(existing);
  return normalized === undefined
    ? appended
    : appendUserContent({ appended, existing: normalized });
}

export function dropStaleSessionLimitContinuationResponses(input: {
  readonly pendingRequestIds: ReadonlySet<string>;
  readonly stepInput?: StepInput;
}): StepInput | undefined {
  if (input.stepInput === undefined) return undefined;
  const responses = input.stepInput.inputResponses ?? [];
  const attributed = input.stepInput.attributedInputResponses ?? [];
  const keep = (requestId: string) =>
    input.pendingRequestIds.has(requestId) || !isSessionLimitContinuationRequestId(requestId);
  const retained = responses.filter((response) => keep(response.requestId));
  const retainedAttributed = attributed.filter(({ response }) => keep(response.requestId));
  if (retained.length === responses.length && retainedAttributed.length === attributed.length) {
    return input.stepInput;
  }

  const {
    attributedInputResponses: _attributed,
    inputResponses: _responses,
    ...remainingInput
  } = input.stepInput;
  const result: { -readonly [K in keyof StepInput]: StepInput[K] } = remainingInput;
  if (retained.length > 0) result.inputResponses = retained;
  if (retainedAttributed.length > 0) result.attributedInputResponses = retainedAttributed;
  return result;
}
