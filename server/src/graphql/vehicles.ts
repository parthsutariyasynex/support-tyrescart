import { addVehicle, deleteVehicle, listVehicles, searchVehicleCustomers, updateVehicle } from '../services/vehicles.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "A customer's vehicle (one CRM contact has any number)"
  type Vehicle {
    id: ID!
    contactId: ID!
    "Uppercase, e.g. DUBAI A 12345"
    plateNumber: String
    make: String!
    model: String!
    year: Int!
    "yyyy-mm-dd"
    registrationDate: String
    "yyyy-mm-dd: last tyre purchase or service"
    lastServiceDate: String
    tireSize1: String!
    tireSize2: String
    "Free-text notes about this vehicle"
    remarks: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  "A contact offered by the CRM Customer picker"
  type VehicleCustomer {
    id: ID!
    name: String
    waId: String!
  }

  input VehicleInput {
    contactId: ID!
    plateNumber: String
    make: String!
    model: String!
    year: Int!
    "yyyy-mm-dd, not in the future"
    registrationDate: String
    "yyyy-mm-dd, not in the future"
    lastServiceDate: String
    tireSize1: String!
    tireSize2: String
    remarks: String
  }

  "Edit: only the fields sent change; null clears an optional one"
  input UpdateVehicleInput {
    plateNumber: String
    make: String
    model: String
    year: Int
    registrationDate: String
    lastServiceDate: String
    tireSize1: String
    tireSize2: String
    remarks: String
  }

  extend type Query {
    "This contact's vehicles, newest first"
    contactVehicles(contactId: ID!): [Vehicle!]!
    "Up to 20 contacts matching name, first/last name or WhatsApp number digits"
    vehicleCustomers(search: String): [VehicleCustomer!]!
  }

  extend type Mutation {
    addVehicle(input: VehicleInput!): Vehicle!
    updateVehicle(id: ID!, input: UpdateVehicleInput!): Vehicle!
    "Soft delete"
    deleteVehicle(id: ID!): Boolean!
  }
`;

export const resolvers = {
  Query: {
    contactVehicles: authed(({ contactId }: { contactId: string }, auth) => listVehicles(auth, contactId)),
    vehicleCustomers: authed(({ search }: { search?: string | null }, auth) => searchVehicleCustomers(auth, search)),
  },
  Mutation: {
    addVehicle: authed(({ input }: { input: unknown }, auth) => addVehicle(auth, input)),
    updateVehicle: authed(({ id, input }: { id: string; input: unknown }, auth) => updateVehicle(auth, id, input)),
    deleteVehicle: authed(({ id }: { id: string }, auth) => deleteVehicle(auth, id)),
  },
};
