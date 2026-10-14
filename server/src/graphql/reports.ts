import { listAssignmentReport } from '../services/assignmentReports.js';
import { authed } from './shared.js';

// Reports section. Every query here is owner/admin only on the server (requireAdmin inside the service); the
// data lives in its own table and is not reachable through conversation, message or activity queries.
export const typeDefs = /* GraphQL */ `
  "A member who held a chat at the time of the assignment (names copied then, so removed members still read correctly)"
  type AssignmentParty {
    "Member id (table Role); null if that membership no longer exists at write time"
    memberId: ID
    userId: ID
    name: String!
  }

  "Who made the assignment; null for a system change (e.g. a removed member's chats being released)"
  type AssignmentActor {
    userId: ID
    name: String!
  }

  "One assignment, reassignment or unassignment of a chat, with the optional Assignment Reason. Admin report only."
  type AssignmentRecord {
    id: ID!
    "Chat ID"
    conversationId: ID!
    contactName: String
    contactWaId: String!
    "null = the chat was unassigned before"
    previousAssignee: AssignmentParty
    "null = unassigned"
    newAssignee: AssignmentParty
    assignedBy: AssignmentActor
    "The Assignment Reason typed in the Assign box, if any"
    reason: String
    "Assignment timestamp"
    createdAt: DateTime!
  }

  extend type Query {
    "Owners and admins only (FORBIDDEN otherwise). Newest first; from/to bound the assignment time; first caps the rows (max 10000)."
    assignmentReport(from: DateTime, to: DateTime, conversationId: ID, first: Int): [AssignmentRecord!]!
  }
`;

export const resolvers = {
  Query: {
    assignmentReport: authed(
      (args: { from?: Date | null; to?: Date | null; conversationId?: string | null; first?: number | null }, auth) =>
        listAssignmentReport(auth, args),
    ),
  },
};
