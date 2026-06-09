# Plan Design Guidelines

<PLAN_DESIGN_GUIDELINES>

## Plan Design Principles

**MUST:**

1. You **MUST** use the following component templates to generate relevant contents in the **Design** section in a session plan file.
2. You **MUST** pick the components in **Primary Contents** to form the design description according to **The Pyramid Principle**.
3. You **MUST** pick the components in **Supplementary Contents** to complete the design description in the relevant aspects according to **The Pyramid Principle**.
4. You **MUST** pick only necessary components to describe the plan design.

**MUST NOT:**

1. You **MUST NOT** create dedicated sections in the session plan file like **Primary Contents** and **Supplementary Contents**.
2. You **MUST NOT** pick more components when the picked components can clearly describe the plan design.

## Primary Contents

### User Story Map

You **MUST** use this template when the plan introduces or changes user-facing workflows that span multiple activities or steps.

```markdown
## User Story Map

<!--
You **MUST** illustrate the user story map before AND after the changes.
You **MUST** NOT just illustrate the user story map before OR after the changes and illustrate another with text descriptions.

The user story map arranges user activities along the horizontal axis (the user's journey) and story detail/priority along the vertical axis.

**DO** illustrate with one of the following forms:

- Diagrams, DO NOT output Mermaid syntax.

**DO NOT** illustrate with any of the following forms:

- Ordered list
- Unordered list
- Table
- Dedicated text descriptions
-->
```

### User Stories

You **MUST** use this template when the plan introduces or changes discrete user-facing capabilities.

```markdown
## User Stories

<!--
You **MUST** list the user stories that are added, removed, or changed by this plan.

Each user story **MUST** follow the format:
- As a [role], I want [capability], so that [benefit].

**DO** illustrate with one of the following forms:

- Ordered list

**DO NOT** illustrate with any of the following forms:

- Diagrams
- Unordered list
- Table
- Dedicated text descriptions
-->
```

### Business

You **MUST** use this template when the plan is focused on business changes.

```markdown
## Business

<!--
You **MUST** illustrate the business model before AND after the changes.
You **MUST** NOT just illustrate the business model before OR after the changes and illustrate another with text descriptions.

The business model describes how you abstract the entire business and the workflow of the product. It sits above the architecture and concerns itself with:

- Domain entities and their relationships
- Business workflows and processes
- Product-level rules and constraints

**DO** illustrate with one of the following forms:

- Diagrams, DO NOT output Mermaid syntax.

**DO NOT** illustrate with any of the following forms:

- Ordered list
- Unordered list
- Table
- Dedicated text descriptions
-->
```

### Architecture

You **MUST** use this template when the plan is focused on architectural changes.

```markdown
## Architecture

<!--
You **MUST** illustrate the architecture before AND after the changes.
You **MUST** NOT just illustrate the architecture before OR after the changes and illustrate another with text descriptions.

**DO** illustrate with one of the following forms:

- Diagrams, DO NOT output Mermaid syntax.

**DO NOT** illustrate with any of the following forms:

- Ordered list
- Unordered list
- Table
- Dedicated text descriptions
-->
```

### Algorithm Design

You **MUST** use this template when the plan is focused on algorithm design changes.
You **MUST** use this template when new and critical algorithms are introduced or changes are introduced to existing critical algorithms.

```markdown
## Algorithm Design

<!--

Formulae are allowed if can be expressed in markdown.

**MUST:**

1. You **MUST** illustrate with one of the following forms:
    - Diagrams, DO NOT output Mermaid syntax.

**MUST NOT:**

1. **DO NOT** illustrate with any of the following forms:
    - Dedicated text descriptions
-->
```

### Verification

You **MUST** use this template when the plan involves code, configuration, or prompt additions, removals, and changes.

```markdown
## Verification
<!--

**MUST:**

1. You **MUST** present how to verify the plan in the following format.
2. You **MUST** map entities to verify to scopes: **Unit**, **Integration**, **System**, **End-to-end(E2E)**, or **Regression** (bug reproducer).
3. You **MUST** design the verifications for each entity as a specification, including:
    - **Specifies** (one line: what behavior or requirement this verification locks in);
    - Short **Given / When / Then** (GWT) or **Arrange / Act / Assert** where useful (especially integration/end-to-end(E2E));
4. You **MUST** design a set of **Reproducers** (expected failure before fix, pass after) for bug-fix plans.
5. You **MUST** always list **Happy Paths** cases.
6. You **MUST** list **Edge / negative** cases when not obvious from names.
7. You **MUST** scale the verification depth with plan risk.
8. You **MAY** add a **Coverage map** (requirement, user story, or risk → test file or case id) for large scopes when the test coverage infrastructure is ready in the project.

**MUST NOT:**
1. You **MUST NOT** require full GWT for trivial refactors.
2. You **MUST NOT** require **Reproducers** for non bug-fix plans.

<VERIFICATION_SCOPES>
- **Unit:** Plan production code and unit tests together; include happy path and edge cases; use exact paths for both.
- **Integration:** Plan integration tests when components are orchestrated across boundaries (modules, processes, DB, network, etc.).
- **End-to-end(E2E):** Plan E2E (or stack-appropriate) tests when the full workflow must be proven after wiring.
- **Regression:** You **MUST** schedule a regression reproducer (failing test or minimal repro) before tasks that apply the fix; ordering must be explicit in **Tasks**.
</VERIFICATION_SCOPES>

-->

### [Name of The Entity to Verify]

**Scope:** [Unit|Integration|System|End-to-end|Regression|Manual]

**Test cases:**

1. [Reproducer] <test case description> [only appeared for bugfix plans]

2. [Reproducer] <test case description> [only appeared for bugfix plans]

3. [Happ Path] <test case description>

4. [Happ Path] <test case description>

5. [Edge] <test case description>

6. [Negative] <test case description>

**Remove:**

1. [Reproducer] <test case description> [only appeared for bugfix plans]

2. [Reproducer] <test case description> [only appeared for bugfix plans]

3. [Happ Path] <test case description>

4. [Happ Path] <test case description>

5. [Edge] <test case description>

6. [Negative] <test case description>


```

## Supplemenray Contents

### Project Structure

You **MUST** use this template to preview additions, removals, or changes of the project structure in the plan when there are files added, removed, renamed or moved in this plan.

```markdown
## Project Structure

<!-- 
You **MUST** illustrate the project structure before AND after the changes.
You **MUST** NOT just illustrate the project structure before OR after the changes and illustrate another with text descriptions.

**DO** illustrate with one of the following forms:

- box-drawing characters used by UNIX command `tree`

**DO NOT** illustrate with any of the following forms:

- Diagrams
- Ordered list
- Unordered list
- Table
- Dedicated text descriptions
-->
```

### Tech Stack

You **MUST** use this template when additions, removals, or changes are introduced to the tech stack.

```markdown
## Tech Stack

<!--
You **MUST** illustrate the tech stack before AND after the changes.
You **MUST** NOT just illustrate the tech stack before OR after the changes and illustrate another with text descriptions.

**DO** illustrate with one of the following forms:

- Diagrams, DO NOT output Mermaid syntax.
- Ordered list

**DO NOT** illustrate with any of the following forms:

- Unordered list
- Table
- Dedicated text descriptions
-->
```

</PLAN_DESIGN_GUIDELINES>
