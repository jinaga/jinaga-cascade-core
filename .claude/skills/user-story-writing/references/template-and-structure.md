# User Story Template and Structure

Use this as a copy-paste starting point for a new user story. Replace placeholders in square brackets and remove any sections that do not apply.

---

```markdown
# User Story: [Short, Title-Case Name]

## Story
**As a** [role, e.g. business user, developer, analyst]
**I want to** [one clear capability or action the user can perform]
**So that** [observable outcome or benefit]

## Description

[2–4 paragraphs of narrative context. Explain the user's situation, what they see, and what they can do. Use subsections (###) for distinct concepts, design decisions, or in/out of scope.]

### [Optional subsection, e.g. Design Decisions]
[Bullets or short paragraphs.]

### [Optional subsection, e.g. Out of Scope]
[What this story explicitly does not cover.]

## Acceptance Criteria

[Group scenarios under ### by theme. Use #### for sub-groups. Number each AC for traceability.]

### [Theme 1, e.g. Initial State and Discovery]

#### AC1: [Short AC title]
**Given** [precondition – state of system or user]
**When** [trigger – user action or system event]
**Then** [observable outcome]
**And** [additional Then or Given/When clause as needed]

#### AC2: [Short AC title]
**Given** …
**When** …
**Then** …

### [Theme 2, e.g. Validation and Errors]

#### AC3: …
…

## Technical Notes

- [Implementation hint, pattern, or constraint]
- [Relevant file, module, or API]
- [Any note that helps implementers without duplicating the AC]

## Related Files

- [path/to/file.ts or component]
- [path/to/context or service]

## Related User Stories

- **[Story name]** – [prerequisite / extends / conflicts with / uses]
- **[Story name]** – …

## Related User Journeys

This story is part of **Journey [N]: [Name]** ([doc reference if applicable]). [One sentence on how it fits.]
```

---

## Section Guidelines

| Section | Guidelines |
|--------|------------|
| **Title** | Short, title-case. No period. E.g. "Rename Property Pipeline Step and Top-Level Array in Preview". |
| **Story** | One sentence per line. Role should be consistent (e.g. "business user"). "I want to" = single capability. |
| **Description** | No ACs here; keep narrative. Subsections for design choices, scope, or multiple features. |
| **Acceptance Criteria** | Each AC must be testable. Avoid "should" in Then; prefer "shall" for hard requirements. Use Given/When/Then consistently. |
| **Technical Notes** | Optional. Use for non-obvious implementation details, file locations, or patterns. |
| **Related Files** | Paths relative to repo root. List files that will be created or modified. |
| **Related User Stories** | Name other stories and state relationship (depends on, extends, conflicts). |
| **Related User Journeys** | Reference architecture or journey docs when the story is part of a larger flow. |

## Acceptance Criteria Numbering

- Use `AC1`, `AC2`, … at the top level.
- For sub-criteria under a theme, use `AC5.1`, `AC5.2` or continue flat `AC6`, `AC7`.
- Reference ACs in discussions or implementation ("AC3 requires …").

## Vocabulary Consistency

Use the same terms across stories so dependencies and conflicts are easy to spot. Examples from this repo:

- **Preview pane** (not "object list" alone when referring to the pipeline output area)
- **Pipeline steps list** (left side of pipeline editor)
- **Command bar** (top bar with step buttons)
- **Configuration mode** (step is being configured, not yet complete)
- **Scope path** / **In clause** (e.g. "In [products]")

Define domain terms once in the story or in a shared doc; reuse in Related User Stories and ACs.
