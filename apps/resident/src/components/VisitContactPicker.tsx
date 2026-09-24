import type { VisitContact } from "@oncare/web-common";
import { t } from "@oncare/web-common";

export type ResidentVisitContact = VisitContact & {
  active?: boolean;
  consentVideo?: boolean;
  consentRobotVisit?: boolean;
};

function isApproved(contact: ResidentVisitContact): boolean {
  return contact.active !== false && contact.consentVideo !== false && contact.consentRobotVisit !== false;
}

export function VisitContactPicker({
  contacts,
  selectedContactId,
  onSelect,
  compact = false,
}: {
  contacts: ResidentVisitContact[];
  selectedContactId: string | null;
  onSelect: (contactUserId: string) => void;
  compact?: boolean;
}) {
  const approvedContacts = contacts.filter(isApproved);

  if (approvedContacts.length === 0) {
    return <p className="visit-contact-picker__empty" role="status">{t("resident.visit.no_contacts")}</p>;
  }

  return <fieldset className={`visit-contact-picker${compact ? " visit-contact-picker--compact" : ""}`}>
    <legend>{t("resident.visit.choose_contact")}</legend>
    <div className="visit-contact-picker__options">
      {approvedContacts.map((contact) => <label className="visit-contact" key={contact.userId}>
        <input
          type="radio"
          name="visit-contact"
          value={contact.userId}
          checked={selectedContactId === contact.userId}
          onChange={() => onSelect(contact.userId)}
        />
        <span>
          <strong>{contact.displayName}</strong>
          <small>{contact.label}</small>
        </span>
      </label>)}
    </div>
  </fieldset>;
}
