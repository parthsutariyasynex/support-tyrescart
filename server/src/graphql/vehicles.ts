import { addVehicle, deleteVehicle, listVehicles, searchVehicleCustomers } from '../services/vehicles.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "A customer's vehicle (chat header → Vehicles)"
  type Vehicle {
    id: ID!
    contactId: ID!
    plateNumber: String!
    make: String!
    model: String!
    year: Int!
    "Calendar day, yyyy-mm-dd"
    registrationDate: String
    "Last purchase / service day, yyyy-mm-dd"
    lastServiceDate: String
    tireSize1: String!
    tireSize2: String
    createdAt: DateTime!
  }

  "A CRM customer to pick for a vehicle"
  type VehicleCustomer {
    id: ID!
    name: String
    waId: String!
  }

  input VehicleInput {
    contactId: ID!
    plateNumber: String!
    make: String!
    model: String!
    year: Int!
    registrationDate: String
    lastServiceDate: String
    tireSize1: String!
    tireSize2: String
  }

  extend type Query {
    "Newest first"
    contactVehicles(contactId: ID!): [Vehicle!]!
    "Contacts by name or number (up to 20)"
    vehicleCustomers(search: String): [VehicleCustomer!]!
  }

  extend type Mutation {
    addVehicle(input: VehicleInput!): Vehicle!
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
    deleteVehicle: authed(({ id }: { id: string }, auth) => deleteVehicle(auth, id)),
  },
};
