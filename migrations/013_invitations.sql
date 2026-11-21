CREATE TABLE invitations (
  id uuid PRIMARY KEY REFERENCES identity_messages ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin','member')),
  invited_by uuid REFERENCES users ON DELETE SET NULL
);
CREATE INDEX invitations_org ON invitations(organization_id);
