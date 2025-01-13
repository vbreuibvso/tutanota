import type {
	AdvancedRepeatRule,
	CalendarEvent,
	CalendarEventAttendee,
	CalendarRepeatRule,
	EncryptedMailAddress,
} from "../../../../common/api/entities/tutanota/TypeRefs.js"
import { createCalendarEventAttendee, createEncryptedMailAddress } from "../../../../common/api/entities/tutanota/TypeRefs.js"
import m, { Children, Component, Vnode } from "mithril"
import { AllIcons, Icon, IconSize } from "../../../../common/gui/base/Icon.js"
import { theme } from "../../../../common/gui/theme.js"
import { BootIcons } from "../../../../common/gui/base/icons/BootIcons.js"
import { Icons } from "../../../../common/gui/base/icons/Icons.js"
import { getRepeatEndTimeForDisplay, getTimeZone } from "../../../../common/calendar/date/CalendarUtils.js"
import { CalendarAttendeeStatus, EndType, getAttendeeStatus, RepeatPeriod } from "../../../../common/api/common/TutanotaConstants.js"
import { downcast, memoized } from "@tutao/tutanota-utils"
import { lang, TranslationKey } from "../../../../common/misc/LanguageViewModel.js"
import type { RepeatRule } from "../../../../common/api/entities/sys/TypeRefs.js"
import { cleanMailAddress, findAttendeeInAddresses, isAllDayEvent } from "../../../../common/api/common/utils/CommonCalendarUtils.js"
import { formatDateWithMonth } from "../../../../common/misc/Formatter.js"
import { BannerButton, BannerButtonAttrs } from "../../../../common/gui/base/buttons/BannerButton.js"
import { pureComponent } from "../../../../common/gui/base/PureComponent.js"
import { CalendarEventPreviewViewModel } from "./CalendarEventPreviewViewModel.js"
import { UpgradeRequiredError } from "../../../../common/api/main/UpgradeRequiredError.js"
import { showPlanUpgradeRequiredDialog } from "../../../../common/misc/SubscriptionDialogs.js"
import { ExternalLink } from "../../../../common/gui/base/ExternalLink.js"

import { createRepeatRuleFrequencyValues, formatEventDuration, getDisplayEventTitle, iconForAttendeeStatus } from "../CalendarGuiUtils.js"
import { hasError } from "../../../../common/api/common/utils/ErrorUtils.js"
import { ByRule } from "../../../../common/calendar/import/ImportExportUtils.js"

export type EventPreviewViewAttrs = {
	event: Omit<CalendarEvent, "description">
	sanitizedDescription: string | null
	participation?: ReturnType<typeof CalendarEventPreviewViewModel.prototype.getParticipationSetterAndThen>
}

/** the buttons enabling the user to view their current participation status on an event and to trigger a change to it, including
 * a mail to the organizer. */
export const ReplyButtons = pureComponent((participation: NonNullable<EventPreviewViewAttrs["participation"]>) => {
	const colors = {
		borderColor: theme.content_button,
		color: theme.content_fg,
	}

	const highlightColors = {
		borderColor: theme.content_accent,
		color: theme.content_accent,
	}

	const makeStatusButtonAttrs = (status: CalendarAttendeeStatus, text: TranslationKey): BannerButtonAttrs =>
		Object.assign(
			{
				text,
				class: "width-min-content",
				click: async () => {
					try {
						await participation.setParticipation(status)
					} catch (e) {
						if (e instanceof UpgradeRequiredError) {
							const ordered = await showPlanUpgradeRequiredDialog(e.plans, e.message)
							if (!ordered) return
							await participation.setParticipation(status)
						} else {
							throw e
						}
					}
				},
			},
			participation.ownAttendee.status === status ? highlightColors : colors,
		)

	return m(".flex.col", [
		m(".small", lang.get("invitedToEvent_msg")),
		m(".flex.items-center.mt-s", [
			m(BannerButton, makeStatusButtonAttrs(CalendarAttendeeStatus.ACCEPTED, "yes_label")),
			m(BannerButton, makeStatusButtonAttrs(CalendarAttendeeStatus.TENTATIVE, "maybe_label")),
			m(BannerButton, makeStatusButtonAttrs(CalendarAttendeeStatus.DECLINED, "no_label")),
		]),
	])
})

export class EventPreviewView implements Component<EventPreviewViewAttrs> {
	// Cache the parsed URL, so we don't parse the URL on every single view call
	private readonly getLocationUrl: typeof getLocationUrl

	constructor() {
		this.getLocationUrl = memoized(getLocationUrl)
	}

	view(vnode: Vnode<EventPreviewViewAttrs>): Children {
		const { event, sanitizedDescription, participation } = vnode.attrs
		const attendees = prepareAttendees(event.attendees, event.organizer)
		const eventTitle = getDisplayEventTitle(event.summary)

		return m(".flex.col.smaller.scroll.visible-scrollbar", [
			this.renderRow(BootIcons.Calendar, [m("span.h3", eventTitle)]),
			this.renderRow(Icons.Time, [formatEventDuration(event, getTimeZone(), false), this.renderRepeatRule(event.repeatRule, isAllDayEvent(event))]),
			this.renderLocation(event.location),
			this.renderAttendeesSection(attendees, participation),
			this.renderAttendanceSection(event, attendees, participation),
			this.renderDescription(sanitizedDescription),
		])
	}

	private renderRow(headerIcon: AllIcons, children: Children, isAlignedLeft?: boolean): Children {
		return m(
			".flex.pb-s",
			{
				class: isAlignedLeft ? "items-start" : "items-center",
			},
			[this.renderSectionIndicator(headerIcon, isAlignedLeft ? { marginTop: "2px" } : undefined), m(".selectable.text-break.full-width", children)],
		)
	}

	private renderSectionIndicator(icon: AllIcons, style: Record<string, any> = {}): Children {
		return m(Icon, {
			icon,
			class: "pr",
			size: IconSize.Medium,
			style: Object.assign(
				{
					fill: theme.content_button,
					display: "block",
				},
				style,
			),
		})
	}

	private renderRepeatRule(rule: CalendarRepeatRule | null, isAllDay: boolean): Children {
		if (rule == null) return null

		const frequency = formatRepetitionFrequency(rule)

		if (frequency) {
			return m("", frequency + formatRepetitionEnd(rule, isAllDay))
		} else {
			// If we cannot properly process the frequency we just indicate that the event is part of a series.
			return m("", lang.get("unknownRepetition_msg"))
		}
	}

	private renderLocation(location: string | null): Children {
		if (location == null || location.trim().length === 0) return null
		return this.renderRow(Icons.Pin, [
			m(
				".text-ellipsis.selectable",
				m(ExternalLink, {
					href: this.getLocationUrl(location.trim()).toString(),
					text: location,
					isCompanySite: false,
				}),
			),
		])
	}

	private renderAttendeesSection(attendees: Array<CalendarEventAttendee>, participation: EventPreviewViewAttrs["participation"]): Children {
		if (attendees.length === 0) return null
		return this.renderRow(
			Icons.People,
			[
				m(
					".flex-wrap",
					attendees.map((a) => this.renderAttendee(a, participation)),
				),
			],
			true,
		)
	}

	/**
	 * if we're an attendee of this event, this renders a selector to be able to set our own attendance.
	 * @param event if the event is not in a calendar, we don't want to set our attendance from here.
	 * @param attendees list of attendees (including the organizer)
	 * @param participation
	 * @private
	 */
	private renderAttendanceSection(
		event: EventPreviewViewAttrs["event"],
		attendees: Array<CalendarEventAttendee>,
		participation: EventPreviewViewAttrs["participation"],
	): Children {
		if (attendees.length === 0 || participation == null || event._ownerGroup == null) return null
		return m(".flex.pb-s", [this.renderSectionIndicator(BootIcons.Contacts), m(ReplyButtons, participation)])
	}

	private renderAttendee(attendee: CalendarEventAttendee, participation: EventPreviewViewAttrs["participation"]): Children {
		const attendeeField = hasError(attendee.address) ? lang.get("corruptedValue_msg") : attendee.address.address
		/** we might have a more current local attendance for ourselves. */
		const status =
			participation != null && cleanMailAddress(attendee.address.address) === participation.ownAttendee.address.address
				? getAttendeeStatus(participation.ownAttendee)
				: getAttendeeStatus(attendee)

		return m(".flex.items-center", [
			m(Icon, {
				icon: iconForAttendeeStatus[status],
				style: {
					fill: theme.content_fg,
				},
				class: "mr-s",
			}),
			m(".span.line-break-anywhere.selectable", attendeeField),
		])
	}

	private renderDescription(sanitizedDescription: string | null) {
		if (sanitizedDescription == null || sanitizedDescription.length === 0) return null
		return this.renderRow(Icons.AlignLeft, [m.trust(sanitizedDescription)], true)
	}
}

/**
 * if text is a valid absolute url, then returns a URL with text as the href
 * otherwise passes text as the search parameter for open street map
 * @param text
 * @returns {*}
 */
export function getLocationUrl(text: string): URL {
	const osmHref = `https://www.openstreetmap.org/search?query=${text}`
	let url

	try {
		// if not a valid _absolute_ url then we get an exception
		url = new URL(text)
	} catch {
		url = new URL(osmHref)
	}

	return url
}

export function formatRepetitionFrequency(repeatRule: RepeatRule): string | null {
	if (repeatRule.interval === "1") {
		const frequency = createRepeatRuleFrequencyValues().find((frequency) => frequency.value === repeatRule.frequency)

		if (frequency) {
			const freq = frequency.name
			const readable = buildReadableAdvancedRepetitionRule(repeatRule.advancedRules)

			return (freq + " " + readable).trim()
		}
	} else {
		return (
			lang.get("repetition_msg", {
				"{interval}": repeatRule.interval,
				"{timeUnit}": getFrequencyTimeUnit(downcast(repeatRule.frequency)),
			}) +
			" " +
			buildReadableAdvancedRepetitionRule(repeatRule.advancedRules)
		).trim()
	}

	return null
}

function buildReadableAdvancedRepetitionRule(advancedRule: AdvancedRepeatRule[]): string {
	const months: string[] = []
	const days: string[] = []
	const monthDays: string[] = []
	const yearDays: string[] = []
	const weekNumber: string[] = []
	const setPos: string[] = []

	advancedRule.forEach((item) => {
		switch (item.ruleType) {
			case ByRule.BYMONTH:
				months.push(item.interval)
				break
			case ByRule.BYDAY:
				days.push(item.interval)
				break
			case ByRule.BYMONTHDAY:
				monthDays.push(item.interval)
				break
			case ByRule.BYYEARDAY:
				yearDays.push(item.interval)
				break
			case ByRule.BYWEEKNO:
				weekNumber.push(item.interval)
				break
			case ByRule.BYSETPOS:
				setPos.push(item.interval)
				break
		}
	})

	const descriptions: string[] = []

	if (months.length > 0) {
		descriptions.push(
			lang.get("inMonths_label", {
				"{months}": joinWithAnd(
					months.map((month) => parseMonthNumber(month)),
					", ",
					lang.get("and_label"),
				),
			}),
		)
	}

	if (days.length > 0) {
		if (monthDays.length > 0) {
			console.log("Month Days: ", monthDays)
			const partOne = lang
				.get("nthOf_label", {
					"{day}": joinWithAnd(monthDays, ", ", lang.get("and_label")),
					"{period}": months.length > 0 ? lang.get("month_label") : "",
				})
				.trim()

			const partTwo = lang.get("onDays_label", {
				"{days}": joinWithAnd(
					days.map((day) => parseShortDay(day)),
					", ",
					lang.get("and_label"),
				),
			})

			descriptions.push(`${partOne} ${partTwo}`.trim())
		} else if (yearDays.length > 0) {
			const partOne = lang
				.get("nthOf_label", {
					"{day}": joinWithAnd(yearDays, ", ", lang.get("and_label")),
					"{period}": months.length > 0 ? lang.get("year_label") : "",
				})
				.trim()

			const partTwo = lang.get("onDays_label", {
				"{days}": joinWithAnd(
					days.map((day) => parseShortDay(day)),
					", ",
					lang.get("and_label"),
				),
			})

			descriptions.push(`${partOne} ${partTwo}`.trim())
		} else {
			descriptions.push(
				lang.get("onDays_label", {
					"{days}": joinWithAnd(
						days.map((day) => parseShortDay(day)),
						", ",
						lang.get("and_label"),
					),
				}),
			)
		}
	} else if (monthDays.length > 0) {
		descriptions.push(
			lang
				.get("nthOf_label", {
					"{day}": joinWithAnd(monthDays, ", ", lang.get("and_label")),
					"{period}": months.length > 0 ? lang.get("month_label") : "",
				})
				.trim(),
		)
	} else if (yearDays.length > 0) {
		descriptions.push(
			lang
				.get("nthOf_label", {
					"{day}": joinWithAnd(yearDays, ", ", lang.get("and_label")),
					"{period}": months.length > 0 ? lang.get("year_label") : "",
				})
				.trim(),
		)
	}

	if (weekNumber.length > 0) {
		descriptions.push(lang.get("inWeek_label", { "{weeks}": joinWithAnd(weekNumber, ", ", lang.get("and_label")) }).trim())
	}

	if (setPos.length > 0) {
		descriptions.push(lang.get("occurrenceWithinSet_label", { "{occurrences}": joinWithAnd(setPos, ", ", lang.get("and_label")) }))
	}

	return descriptions.join(" ")
}

function joinWithAnd(items: any[], separator: string, lastSeparator: string) {
	if (items.length > 1) {
		const last = items.pop()
		const joinedString = items.join(separator)

		return `${joinedString} ${lastSeparator} ${last}`
	}

	return items.join(separator)
}

/**
 * @returns {string} The returned string includes a leading separator (", " or " ").
 */
export function formatRepetitionEnd(repeatRule: RepeatRule, isAllDay: boolean): string {
	switch (repeatRule.endType) {
		case EndType.Count:
			if (!repeatRule.endValue) {
				return ""
			}

			return (
				", " +
				lang.get("times_msg", {
					"{amount}": repeatRule.endValue,
				})
			)

		case EndType.UntilDate:
			const repeatEndTime = getRepeatEndTimeForDisplay(repeatRule, isAllDay, getTimeZone())
			return " " + lang.get("until_label") + " " + formatDateWithMonth(repeatEndTime)

		default:
			return ""
	}
}

function getFrequencyTimeUnit(frequency: RepeatPeriod): string {
	switch (frequency) {
		case RepeatPeriod.DAILY:
			return lang.get("days_label")

		case RepeatPeriod.WEEKLY:
			return lang.get("weeks_label")

		case RepeatPeriod.MONTHLY:
			return lang.get("pricing.months_label")

		case RepeatPeriod.ANNUALLY:
			return lang.get("years_label")

		default:
			throw new Error("Unknown calendar event repeat rule frequency: " + frequency)
	}
}

function parseShortDay(day: string) {
	switch (day) {
		case "MO":
			return lang.get("monday_label")
		case "TU":
			return lang.get("tuesday_label")
		case "WE":
			return lang.get("wednesday_label")
		case "TH":
			return lang.get("thursday_label")
		case "FR":
			return lang.get("friday_label")
		case "SA":
			return lang.get("saturday_label")
		case "SU":
			return lang.get("sunday_label")
		default:
			return ""
	}
}

function parseMonthNumber(month: string) {
	switch (month) {
		case "1":
			return lang.get("january_label")
		case "2":
			return lang.get("february_label")
		case "3":
			return lang.get("march_label")
		case "4":
			return lang.get("april_label")
		case "5":
			return lang.get("may_label")
		case "6":
			return lang.get("june_label")
		case "7":
			return lang.get("july_label")
		case "8":
			return lang.get("august_label")
		case "9":
			return lang.get("september_label")
		case "10":
			return lang.get("october_label")
		case "11":
			return lang.get("november_label")
		case "12":
			return lang.get("december_label")
		default:
			return ""
	}
}

function prepareAttendees(attendees: Array<CalendarEventAttendee>, organizer: EncryptedMailAddress | null): Array<CalendarEventAttendee> {
	// We copy the attendees array so that we can add the organizer, in the case that they are not already in attendees
	// This is just for display purposes. We need to copy because event.attendees is the source of truth for the event
	// so we can't modify it
	const attendeesCopy = attendees.slice()

	if (organizer != null && attendeesCopy.length > 0 && !findAttendeeInAddresses(attendeesCopy, [organizer.address])) {
		attendeesCopy.unshift(
			createCalendarEventAttendee({
				address: createEncryptedMailAddress({
					address: organizer.address,
					name: "",
				}),
				status: CalendarAttendeeStatus.ADDED, // We don't know whether the organizer will be attending or not in this case
			}),
		)
	}

	return attendeesCopy
}
