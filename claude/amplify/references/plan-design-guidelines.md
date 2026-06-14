# Plan Design Guidelines

<PLAN_DESIGN_GUIDELINES>

## Plan Design Principles

**MUST:**

1. You **MUST** use the following component templates to generate relevant contents in the **Design** section in a session plan file.
2. You **MUST** pick the components in **Primary Contents** to form the design description according to **The Pyramid Principle**.
3. You **MUST** pick the components in **Supplementary Contents** to complete the design description in the relevant aspects according to **The Pyramid Principle**.
4. You **MUST** pick only necessary components to describe the plan design.
5. You **MUST** treat each component as one mutually exclusive design concern and pick a set of components that is collectively exhaustive over the design concerns this plan touches, so the selection is **MECE** (Mutually Exclusive, Collectively Exhaustive).
6. You **MUST** invent components to describe contents in the plan but cannot described by the existing components in this guidelines. The component lists in this guideline is an open list.
7. You **MUST** align the communication style of any invented components with that of the existing components in these guidelines.

**MUST NOT:**

1. You **MUST NOT** create dedicated sections in the session plan file like **Primary Contents** and **Supplementary Contents**.
2. You **MUST NOT** pick more components when the picked components can clearly describe the plan design.
3. You **MUST NOT** describe the same design concern under more than one component.

## Component Invention Guidelines

<COMPONENT_INVENTION_GUIDELINES>

1. You **MUST** use before/after comparisons to help the user to understand a change whenever possible.
2. You **MUST** find the most commonly used expression style in the industry to express an idea whenever possible.
3. You **MUST** visualize the contents when visual contents can help accelerating human understanding.

</COMPONENT_INVENTION_GUIDELINES>

## Primary Contents

### User Story Map

You **MUST** use this template when the plan introduces or changes user-facing workflows that span multiple activities or steps.

```markdown
## User Story Map

<!--
You **MUST** illustrate the user story map before AND after the changes.
You **MUST** NOT just illustrate the user story map before OR after the changes and illustrate another with text descriptions.

The user story map arranges user activities along the horizontal axis (the user's journey) and story detail/priority along the vertical axis.

<USER_STORY_MAP_EXAMPLE>
              ── user's journey, left → right ───────────────────────►
 BACKBONE   │ [Activity A]        │ [Activity B]      │ [Activity C]       │   high-level activities
 TASKS      │ [task A1] [task A2] │ [task B1]         │ [task C1] [task C2]│   steps under each activity
 ───────────┼─────────────────────┼───────────────────┼────────────────────┤
 Release 1  │ [story A1.1]        │ [story B1.1]      │ [story C1.1]       │   top = highest priority
   ▲ pri    │ [story A2.1]        │                   │ [story C2.1]       │
 ───────────┼─────────────────────┼───────────────────┼────────────────────┤
 Release 2  │ [story A1.2]        │ [story B1.2]      │ [story C2.2]       │   lower priority / later
</USER_STORY_MAP_EXAMPLE>

You **MUST** illustrate with one of the following forms:

- A grid-style diagram drawn with box-drawing characters, as in the example above (backbone of activities/tasks across the top, stories stacked by priority and cut into release slices down the side). This is a diagram, not a markdown table.

You **MUST NOT** illustrate with any of the following forms:

- Mermaid syntax
- Ordered list
- Unordered list
- Markdown table
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

<USER_STORY_EXAMPLE>
1. As a [role 1], I want [capability 1],
    so that [benefit 1].
2. As a [role 2], I want [capability 2], 
    so that [benefit 2].
</USER_STORY_EXAMPLE>

You **MUST** illustrate with one of the following forms:

- Ordered list

You **MUST NOT** illustrate with any of the following forms:

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

### Data Structure

You **MUST** use this template when the plan introduces or changes the shape of data — schemas, types, records, or persistent storage models.

```markdown
## Data Structure

<!--
You **MUST** illustrate the data structure before AND after the changes.
You **MUST** NOT just illustrate the data structure before OR after the changes and illustrate another with text descriptions.

The data structure describes the static shape of data: the fields and their types, the records or entities, and the relationships among them. It does not describe runtime behavior or computational steps.

You **MUST** illustrate with one of the following forms:

- Diagrams drawn with box-drawing characters, for example an entity-and-field layout. DO NOT output Mermaid syntax.
- Schema or type definition code blocks, for example a table schema or a type declaration.

You **MUST NOT** illustrate with any of the following forms:

- Mermaid syntax
- Ordered list
- Unordered list
- Markdown table
- Dedicated text descriptions
-->
```

### User Interface

You **MUST** use this template when the plan introduces or changes what the user sees — screens, layout, or visual components.

```markdown
## User Interface

<!--
You **MUST** illustrate the user interface before AND after the changes.
You **MUST** NOT just illustrate the user interface before OR after the changes and illustrate another with text descriptions.

The user interface describes the visual presentation: the screens, the layout, the components on each screen, and their visual hierarchy. It does not describe what happens when the user acts on the interface.

You **MUST** illustrate with one of the following forms:

- Wireframes or mockups drawn with box-drawing characters. DO NOT output Mermaid syntax.

You **MUST NOT** illustrate with any of the following forms:

- Mermaid syntax
- Ordered list
- Unordered list
- Markdown table
- Dedicated text descriptions
-->
```

### User Interaction

You **MUST** use this template when the plan introduces or changes how the user acts on the interface and how the interface responds — input, feedback, and the resulting state transitions.

```markdown
## User Interaction

<!--
You **MUST** illustrate the user interaction before AND after the changes.
You **MUST** NOT just illustrate the user interaction before OR after the changes and illustrate another with text descriptions.

The user interaction describes the dynamic behavior at the interface: the user's input, the feedback or response the system gives, and the state transitions that result. It does not describe the static visual presentation.

You **MUST** illustrate with one of the following forms:

- State or interaction-flow diagrams drawn with box-drawing characters. DO NOT output Mermaid syntax.

You **MUST NOT** illustrate with any of the following forms:

- Mermaid syntax
- Ordered list
- Unordered list
- Markdown table
- Dedicated text descriptions
-->
```

### Verification

You **MUST** use this template when the plan involves code, configuration, or prompt additions, removals, and changes.

```markdown
## Verification
<!--

You **MUST** present how to verify the plan in the following format.

<VERIFICATION_EXAMPLE>
### 1. [Name of The Entity 1 to Verify]

**Scope:** <verification_scope>

**Test cases:**

1. [<test_case_category>] <test case specification written in GWT, AAA or natural language>

2. [<test_case_category>] <test case specification written in GWT, AAA or natural language>

### 2. [Name of The Entity 2 to Verify]

**Scope:** <verification_scope>

**Test cases:**

1. [<test_case_category>] <test case specification written in GWT, AAA or natural language>

2. [<test_case_category>] <test case specification written in GWT, AAA or natural language>

### Coverage Map

<An optional coverage map when the test coverage infrastructure is ready in the project.>

</VERIFICATION_EXAMPLE>

**MUST:**

1. You **MUST** map entities to verify to scopes: **Unit**, **Integration**, **System**, **End-to-end(E2E)**, or **Regression** (bug reproducer).
2. You **MUST** design the verifications for each entity as a specification, including:
    - **Specifies** (one line: what behavior or requirement this verification locks in);
    - Short **Given** / **When** / **Then** (GWT) or **Arrange** / **Act** / **Assert** (AAA) where useful (especially integration/end-to-end(E2E));
3. You **MUST** design a set of **Reproducers** (expected failure before fix, pass after) for bug-fix plans.
4. You **MUST** always list **Happy Paths** cases.
5. You **MUST** list **Edge / negative** cases when not obvious from names.
6. You **MUST** scale the verification depth with plan risk.
7. You **MUST** add a **Coverage map** (requirement, user story, or risk → test file or case id) for large scopes when the test coverage infrastructure is ready in the project.
8. You **MUST** mark a case **Browser-use-enabled** when an `amplify:browser-use-*` subagent can verify it by operating the running web target in a browser and capturing snapshots at checkpoints, and **Computer-use-enabled** when the `amplify:computer-use` subagent can verify it by operating the GUI/desktop on screen and capturing snapshots at checkpoints. These are semi-automated steps that **complement, not replace,** **Manual** cases and human gates: they reclaim part of the manual effort, but the final human check still stands. The runtime audit-resolver derives **Behavioral Verification** auditors from both kinds of case.

**MUST NOT:**
1. You **MUST NOT** require full GWT for trivial refactors.
2. You **MUST NOT** require **Reproducers** for non bug-fix plans.
3. You **MUST NOT** treat a **Browser-use-enabled** or **Computer-use-enabled** case as a substitute for a required human gate.

**Verification Scopes:*

<VERIFICATION_SCOPES>
- **Unit:** Prove a single unit or algorithm in isolation — the lowest design layer (Algorithm Design and individual components). Plan the production code and its unit tests together, with exact paths for both, covering happy-path and edge cases.
- **Integration:** Prove the collaborations across the boundaries the Architecture defines (modules, processes, DB, network, etc.). Plan these when components are orchestrated together.
- **System:** Prove the assembled product honors the Business model — its domain workflows and product-level rules — within one running deployment.
- **End-to-end(E2E):** Prove a complete user story or journey on the User Story Map, exercising the full stack after wiring (or the stack-appropriate equivalent).
- **Regression:** Prove a previously broken user story or business rule stays fixed. You **MUST** schedule a regression reproducer (failing test or minimal repro) before tasks that apply the fix; ordering must be explicit in **Tasks**.
</VERIFICATION_SCOPES>

**Test Case Categories:*

<TEST_CASE_CATEGORIES>
- **Reproducer:** A case that fails before the fix and passes after it, locking in the user story or business rule the defect violated. Applies only to bug-fix plans.
- **Happy Path:** A case exercising a user story's main path with valid input — the primary route through the user story map — proving the promised benefit is delivered.
- **Edge:** A case at a boundary the design defines: the limits of an algorithm or a business constraint (empty, minimum, maximum, off-by-one, concurrent, or otherwise extreme), where correct behavior is easy to lose.
- **Negative:** A case with input the business rules or product-level constraints disallow, confirming the system rejects it and fails in the defined way (error, validation message, or no state change).
- **Browser-use-enabled:** A case an `amplify:browser-use-*` subagent performs by operating the running web target in a browser the way a user would and capturing snapshots at defined checkpoints, then judging them against the User Story Map / User Interface / User Interaction. Semi-automated: it reclaims part of what would otherwise be **Manual** effort, but **complements, not replaces,** a required human gate. The runtime audit-resolver turns these cases into **Behavioral Verification** auditors. Reusing the snapshots as regression baselines is a separate testing-pipeline concern, out of scope here.
- **Computer-use-enabled:** A case the `amplify:computer-use` subagent performs by operating the GUI/desktop on screen the way a user would and capturing snapshots at defined checkpoints, then judging them against the User Story Map / User Interface / User Interaction. Semi-automated: it reclaims part of what would otherwise be **Manual** effort, but **complements, not replaces,** a required human gate. The runtime audit-resolver turns these cases into **Behavioral Verification** auditors. Reusing the snapshots as regression baselines is a separate testing-pipeline concern, out of scope here.
- **Manual:** A case a human must verify because no subagent can reach it (`amplify:computer-use`/`amplify:browser-use-*` unavailable or the path is unreachable) — typically the subjective or experiential aspects of the user story map — per the human-checkpoint criteria in `write-plan/SKILL.md`. Prefer a **Browser-use-enabled** or **Computer-use-enabled** case when a subagent can perform it.
</TEST_CASE_CATEGORIES>

-->

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

You **MUST** present an item's sub-items (for example a category and the specific technologies and versions under it) as a nested ordered sub-list, one sub-item per line, and you **MUST NOT** compact them into a single line.

<TECH_STACK_EXAMPLE>
1. [category 1, e.g. Frontend]
    1. [technology + version, e.g. React 19]
    2. [technology + version, e.g. TypeScript 5.6]
2. [category 2, e.g. Backend]
    1. [technology + version, e.g. Node.js 22]
    2. [technology + version, e.g. PostgreSQL 16]
</TECH_STACK_EXAMPLE>

You **MUST** illustrate with one of the following forms:

- Diagrams, DO NOT output Mermaid syntax.
- Ordered list, with a nested ordered sub-list for any item that has sub-items (as in the example above).

You **MUST NOT** illustrate with any of the following forms:

- Unordered list
- Markdown table
- Dedicated text descriptions
- An item's sub-items compacted onto one line
-->
```

</PLAN_DESIGN_GUIDELINES>
