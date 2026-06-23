from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class NavAddress(BaseModel):
    model_config = ConfigDict(extra="allow")

    sessionId: str
    jsonlFile: str
    lineNumber: int
    eventIndex: int
    scope: str = "main"
    agentPath: str = "main"
    elementType: str = "event"
    view: str = "rendered"
    messageId: str | None = None
    contentIndex: int | None = None
    toolUseId: str | None = None
    jsonPointer: str | None = None
    problemId: str | None = None

    @property
    def key(self) -> str:
        parts = [
            self.sessionId,
            self.agentPath,
            str(self.eventIndex),
            self.elementType,
            str(self.contentIndex if self.contentIndex is not None else ""),
            self.toolUseId or "",
            self.view,
        ]
        return ":".join(parts).replace("/", "_")


class RawEvent(BaseModel):
    id: str
    nav: NavAddress
    raw: dict[str, Any] | str
    parse_error: str | None = None


class ParserDiagnostic(BaseModel):
    id: str
    severity: str = "warning"
    kind: str
    message: str
    nav: NavAddress | None = None
    related: list[NavAddress] = Field(default_factory=list)


class ProblemFlag(BaseModel):
    id: str
    severity: str = "warning"
    kind: str
    reason: str
    nav: NavAddress
    jsonPath: str | None = None
    related: list[NavAddress] = Field(default_factory=list)


class TokenUsage(BaseModel):
    input: int = 0
    output: int = 0
    cache: dict[str, int] | None = None


class GenericPart(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str | None = None
    type: str
    text: str | None = None
    tool: str | None = None
    state: dict[str, Any] | None = None
    tokens: TokenUsage | None = None
    time_created: int | None = None
    synthetic: bool | None = None
    nav: NavAddress | None = None


class ModelInfo(BaseModel):
    providerID: str | None = None
    modelID: str | None = None


class MessageSummary(BaseModel):
    title: str | None = None
    diffs: list[Any] | None = None


class Message(BaseModel):
    id: str | None = None
    role: str
    agent: str | None = None
    model: ModelInfo | str | None = None
    modelID: str | None = None
    time_created: int | None = None
    time_updated: int | None = None
    summary: MessageSummary | None = None
    finish: str | None = None
    parts: list[GenericPart] = Field(default_factory=list)
    nav: NavAddress | None = None


class ConversationSummary(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    title: str | None = None
    directory: str | None = None
    git_branch: str | None = Field(None, alias="gitBranch")
    version: str | None = None
    project_id: str | None = Field(None, alias="projectID")
    parent_id: str | None = None
    time_created: int | None = None
    time_updated: int | None = None
    model: str | None = "Unknown"
    message_count: int = 0
    subagent_count: int = 0
    first_problem: str | None = None


class ConversationExport(BaseModel):
    summary: ConversationSummary
    messages: list[Message]
    subagent_transcripts: list["ConversationExport"] = Field(default_factory=list)
    task_part_id: str | None = None
    task_message_id: str | None = None
    parent_task_nav: NavAddress | None = None
    parent_result_nav: NavAddress | None = None
    previous_sibling_nav: NavAddress | None = None
    next_sibling_nav: NavAddress | None = None
    relationship_hint: str | None = None
    relationship_basis: str | None = None
    agent_type: str | None = None
    agent_description: str | None = None
    raw_events: list[RawEvent] = Field(default_factory=list)
    parser_diagnostics: list[ParserDiagnostic] = Field(default_factory=list)
    problem_flags: list[ProblemFlag] = Field(default_factory=list)
    nav_index: list[NavAddress] = Field(default_factory=list)


ConversationExport.model_rebuild()
