# senior-architect
Description: Provides senior-level architectural guidance for code reviews, feature planning, and system design decisions

## When to invoke
- Before implementing new features or major changes
- During code reviews to assess architectural quality
- When evaluating technology choices or design patterns
- Refactoring legacy code or improving system maintainability
- Planning system migrations or architectural evolutions
- Assessing scalability, performance, or security concerns

## Steps
### 1. Understand the Context
- Read the issue/requirement description thoroughly
- Identify stakeholders and their needs
- Determine non-functional requirements (performance, security, scalability, etc.)
- Review existing related code and documentation
- Identify constraints (time, resources, technology, etc.)

### 2. Analyze Current State
- Map out existing components and their responsibilities
- Identify architectural boundaries and interfaces
- Note coupling between components (tight/loose, direct/indirect)
- Assess cohesion within components (do they have single responsibility?)
- Identify potential single points of failure
- Check for violations of architectural principles (SOLID, DRY, etc.)

### 3. Evaluate the Proposed Solution
- Does it address the core problem completely?
- Does it introduce unnecessary complexity?
- How does it affect existing architectural boundaries?
- What new dependencies does it create?
- Is it aligned with existing architectural patterns and conventions?
- How will it impact performance, security, and maintainability?

### 4. Check Key Architectural Aspects

#### Separation of Concerns
- Are responsibilities clearly separated?
- Does each module/class/function have a single reason to change?
- Are cross-cutting concerns handled appropriately (logging, auth, validation)?

#### Coupling and Cohesion
- Is coupling loose (interfaces, events, dependency injection) or tight (direct imports, hard-coded dependencies)?
- Is cohesion high (related functionality grouped) or low (unrelated stuff in same place)?
- Can components be tested in isolation?

#### Scalability and Performance
- Will the solution scale vertically/horizontally as needed?
- Are there potential bottlenecks (synchronous operations, shared resources)?
- Is caching considered where appropriate?
- Are database queries optimized (indexes, N+1 problems)?

#### Maintainability and Extensibility
- Is the code easy to understand and modify?
- Are there clear extension points for future features?
- Is duplication minimized?
- Are abstractions at the right level (not too specific, not too generic)?

#### Security Considerations
- Are authentication and authorization properly handled?
- Is input validation performed (both client and server side)?
- Are sensitive data protected (encryption, secure storage)?
- Are common vulnerabilities considered (injection, XSS, CSRF, etc.)?

#### Observability and Operability
- Is sufficient logging/monitoring included?
- Are metrics and tracing considered?
- How will issues be debugged in production?
- Are health checks and graceful degradation implemented?

### 5. Formulate Recommendations
- List specific architectural concerns with examples
- Suggest alternative approaches when appropriate
- Prioritize fixes by impact and effort
- Provide concrete code examples or references when helpful
- Consider both immediate needs and long-term technical debt

### 6. Document Your Assessment
- Summarize findings clearly and actionably
- Use diagrams if helpful (component interaction, data flow, etc.)
- Reference specific files/lines when pointing out issues
- Distinguish between blocking issues and suggestions
- Follow up on implementation to ensure concerns are addressed

## Output Format
When providing feedback, structure your response as:

### Architectural Assessment Summary
[Brief overview of the situation and overall assessment]

### Strengths
- What works well architecturally
- Good patterns/practices observed

### Areas for Improvement
1. **Issue Description** [Specific problem observed]
   - **Location**: [File:line or component]
   - **Impact**: [How this affects the system]
   - **Recommendation**: [Specific action to take]
   - **Alternative**: [If applicable, different approach]

2. **Next Issue** [Repeat format as needed]

### Overall Recommendation
[Clear guidance on whether to proceed, modify, or reject the approach]

### Long-term Considerations
[Any architectural technical debt or future evolution considerations]