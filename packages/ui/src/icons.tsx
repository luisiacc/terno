/**
 * The app's icons: Hugeicons (free core set), behind the names the UI already
 * uses (the lucide ones it started with). Mostly Hugeicons' own lucide
 * aliases; where those read poorly at 16px, the closest Hugeicons drawing.
 *
 * Rendered here rather than with @hugeicons/react: its paths carry
 * stroke-width="1.5", which no CSS on the <svg> can reach. Without it they
 * inherit the svg's, so `--icon-stroke` (plan 15) and stroke utilities apply.
 */
import type { ReactElement, Ref, SVGProps } from "react";
// one module per icon: the package index re-exports all ~6,000
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import ArchiveIcon from "@hugeicons/core-free-icons/ArchiveIcon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowDown02Icon from "@hugeicons/core-free-icons/ArrowDown02Icon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import ArrowUp01Icon from "@hugeicons/core-free-icons/ArrowUp01Icon";
import AtIcon from "@hugeicons/core-free-icons/AtIcon";
import Attachment01Icon from "@hugeicons/core-free-icons/Attachment01Icon";
import BotIcon from "@hugeicons/core-free-icons/BotIcon";
import Calendar03Icon from "@hugeicons/core-free-icons/Calendar03Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CheckmarkBadge01Icon from "@hugeicons/core-free-icons/CheckmarkBadge01Icon";
import CheckmarkCircle01Icon from "@hugeicons/core-free-icons/CheckmarkCircle01Icon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import CloudIcon from "@hugeicons/core-free-icons/CloudIcon";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import DatabaseIcon from "@hugeicons/core-free-icons/DatabaseIcon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import Download01Icon from "@hugeicons/core-free-icons/Download01Icon";
import FileDownloadIcon from "@hugeicons/core-free-icons/FileDownloadIcon";
import FilterIcon from "@hugeicons/core-free-icons/FilterIcon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import FolderInputIcon from "@hugeicons/core-free-icons/FolderInputIcon";
import HardDriveIcon from "@hugeicons/core-free-icons/HardDriveIcon";
import ImageAdd01Icon from "@hugeicons/core-free-icons/ImageAdd01Icon";
import ImageNotFound01Icon from "@hugeicons/core-free-icons/ImageNotFound01Icon";
import InboxIcon from "@hugeicons/core-free-icons/InboxIcon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import Key02Icon from "@hugeicons/core-free-icons/Key02Icon";
import KeyboardIcon from "@hugeicons/core-free-icons/KeyboardIcon";
import LaptopIcon from "@hugeicons/core-free-icons/LaptopIcon";
import LaptopMinimalCheckIcon from "@hugeicons/core-free-icons/LaptopMinimalCheckIcon";
import Layers01Icon from "@hugeicons/core-free-icons/Layers01Icon";
import Layout2ColumnIcon from "@hugeicons/core-free-icons/Layout2ColumnIcon";
import Layout3RowIcon from "@hugeicons/core-free-icons/Layout3RowIcon";
import LeftToRightListBulletIcon from "@hugeicons/core-free-icons/LeftToRightListBulletIcon";
import LeftToRightListNumberIcon from "@hugeicons/core-free-icons/LeftToRightListNumberIcon";
import LifebuoyIcon from "@hugeicons/core-free-icons/LifebuoyIcon";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import Link02Icon from "@hugeicons/core-free-icons/Link02Icon";
import ListFilterIcon from "@hugeicons/core-free-icons/ListFilterIcon";
import Loading03Icon from "@hugeicons/core-free-icons/Loading03Icon";
import MagicWand01Icon from "@hugeicons/core-free-icons/MagicWand01Icon";
import Mail01Icon from "@hugeicons/core-free-icons/Mail01Icon";
import MailOpen01Icon from "@hugeicons/core-free-icons/MailOpen01Icon";
import MailValidation01Icon from "@hugeicons/core-free-icons/MailValidation01Icon";
import MailsIcon from "@hugeicons/core-free-icons/MailsIcon";
import Message01Icon from "@hugeicons/core-free-icons/Message01Icon";
import MessageSquareReplyIcon from "@hugeicons/core-free-icons/MessageSquareReplyIcon";
import MoonIcon from "@hugeicons/core-free-icons/MoonIcon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/MoreHorizontalIcon";
import Notification01Icon from "@hugeicons/core-free-icons/Notification01Icon";
import NotificationOff01Icon from "@hugeicons/core-free-icons/NotificationOff01Icon";
import OctagonXIcon from "@hugeicons/core-free-icons/OctagonXIcon";
import PaintBoardIcon from "@hugeicons/core-free-icons/PaintBoardIcon";
import PencilEdit01Icon from "@hugeicons/core-free-icons/PencilEdit01Icon";
import PencilEdit02Icon from "@hugeicons/core-free-icons/PencilEdit02Icon";
import PencilIcon from "@hugeicons/core-free-icons/PencilIcon";
import PlayIcon from "@hugeicons/core-free-icons/PlayIcon";
import PrinterIcon from "@hugeicons/core-free-icons/PrinterIcon";
import QuoteUpIcon from "@hugeicons/core-free-icons/QuoteUpIcon";
import Redo01Icon from "@hugeicons/core-free-icons/Redo01Icon";
import Redo02Icon from "@hugeicons/core-free-icons/Redo02Icon";
import RefreshIcon from "@hugeicons/core-free-icons/RefreshIcon";
import RepeatIcon from "@hugeicons/core-free-icons/RepeatIcon";
import ReplyAllIcon from "@hugeicons/core-free-icons/ReplyAllIcon";
import ReplyIcon from "@hugeicons/core-free-icons/ReplyIcon";
import RotateClockwiseIcon from "@hugeicons/core-free-icons/RotateClockwiseIcon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import SecurityCheckIcon from "@hugeicons/core-free-icons/SecurityCheckIcon";
import SentIcon from "@hugeicons/core-free-icons/SentIcon";
import Settings02Icon from "@hugeicons/core-free-icons/Settings02Icon";
import Share05Icon from "@hugeicons/core-free-icons/Share05Icon";
import SlidersHorizontalIcon from "@hugeicons/core-free-icons/SlidersHorizontalIcon";
import SpamIcon from "@hugeicons/core-free-icons/SpamIcon";
import SparklesIcon from "@hugeicons/core-free-icons/SparklesIcon";
import SquareLock02Icon from "@hugeicons/core-free-icons/SquareLock02Icon";
import StarIcon from "@hugeicons/core-free-icons/StarIcon";
import StarOffIcon from "@hugeicons/core-free-icons/StarOffIcon";
import Sun01Icon from "@hugeicons/core-free-icons/Sun01Icon";
import Tag01Icon from "@hugeicons/core-free-icons/Tag01Icon";
import TextAlignCenterIcon from "@hugeicons/core-free-icons/TextAlignCenterIcon";
import TextAlignLeftIcon from "@hugeicons/core-free-icons/TextAlignLeftIcon";
import TextAlignRightIcon from "@hugeicons/core-free-icons/TextAlignRightIcon";
import TextBoldIcon from "@hugeicons/core-free-icons/TextBoldIcon";
import TextClearIcon from "@hugeicons/core-free-icons/TextClearIcon";
import TextColorIcon from "@hugeicons/core-free-icons/TextColorIcon";
import TextFontIcon from "@hugeicons/core-free-icons/TextFontIcon";
import TextIndentLessIcon from "@hugeicons/core-free-icons/TextIndentLessIcon";
import TextIndentMoreIcon from "@hugeicons/core-free-icons/TextIndentMoreIcon";
import TextItalicIcon from "@hugeicons/core-free-icons/TextItalicIcon";
import TextStrikethroughIcon from "@hugeicons/core-free-icons/TextStrikethroughIcon";
import TextUnderlineIcon from "@hugeicons/core-free-icons/TextUnderlineIcon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";
import TickDouble01Icon from "@hugeicons/core-free-icons/TickDouble01Icon";
import TimeScheduleIcon from "@hugeicons/core-free-icons/TimeScheduleIcon";
import Undo02Icon from "@hugeicons/core-free-icons/Undo02Icon";
import Unlink01Icon from "@hugeicons/core-free-icons/Unlink01Icon";
import Upload01Icon from "@hugeicons/core-free-icons/Upload01Icon";
import UserCircleIcon from "@hugeicons/core-free-icons/UserCircleIcon";
import UserMultipleIcon from "@hugeicons/core-free-icons/UserMultipleIcon";
import ViewOffSlashIcon from "@hugeicons/core-free-icons/ViewOffSlashIcon";
import WifiOff01Icon from "@hugeicons/core-free-icons/WifiOff01Icon";

type IconNode = readonly (readonly [string, { readonly [key: string]: string | number }])[];
export type IconProps = SVGProps<SVGSVGElement> & { size?: number | string; ref?: Ref<SVGSVGElement> };
export type Icon = (props: IconProps) => ReactElement;

function icon(node: IconNode, name: string): Icon {
  const children = node.map(([Tag, { key, ...attrs }]) => {
    delete (attrs as { strokeWidth?: unknown }).strokeWidth;
    return <Tag key={key} {...attrs} />;
  });
  const C = ({ size = 24, className, ...rest }: IconProps) => {
    // decorative unless something names it (as lucide did)
    const named = rest["aria-label"] || rest["aria-labelledby"] || rest.role;
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={named ? undefined : true}
        className={className ? `icon ${className}` : "icon"}
        {...rest}
      >
        {children}
      </svg>
    );
  };
  C.displayName = name;
  return C;
}

export const ALargeSmall = icon(TextFontIcon, "ALargeSmall");
export const Archive = icon(ArchiveIcon, "Archive");
export const ArrowDown = icon(ArrowDown02Icon, "ArrowDown");
export const AtSign = icon(AtIcon, "AtSign");
export const BadgeCheck = icon(CheckmarkBadge01Icon, "BadgeCheck");
export const Baseline = icon(TextColorIcon, "Baseline");
export const Bell = icon(Notification01Icon, "Bell");
export const BellOff = icon(NotificationOff01Icon, "BellOff");
export const Bold = icon(TextBoldIcon, "Bold");
export const Bot = icon(BotIcon, "Bot");
export const CalendarClock = icon(TimeScheduleIcon, "CalendarClock");
export const CalendarDays = icon(Calendar03Icon, "CalendarDays");
export const CaseSensitive = icon(TextFontIcon, "CaseSensitive");
export const Check = icon(Tick02Icon, "Check");
export const CheckCheck = icon(TickDouble01Icon, "CheckCheck");
export const ChevronDown = icon(ArrowDown01Icon, "ChevronDown");
export const ChevronLeft = icon(ArrowLeft01Icon, "ChevronLeft");
export const ChevronRight = icon(ArrowRight01Icon, "ChevronRight");
export const ChevronUp = icon(ArrowUp01Icon, "ChevronUp");
export const CircleAlert = icon(AlertCircleIcon, "CircleAlert");
export const CircleCheck = icon(CheckmarkCircle01Icon, "CircleCheck");
export const Clock = icon(Clock01Icon, "Clock");
export const Cloud = icon(CloudIcon, "Cloud");
export const Columns2 = icon(Layout2ColumnIcon, "Columns2");
export const Copy = icon(Copy01Icon, "Copy");
export const Database = icon(DatabaseIcon, "Database");
export const Download = icon(Download01Icon, "Download");
export const Ellipsis = icon(MoreHorizontalIcon, "Ellipsis");
export const ExternalLink = icon(Share05Icon, "ExternalLink");
export const EyeOff = icon(ViewOffSlashIcon, "EyeOff");
export const FileDown = icon(FileDownloadIcon, "FileDown");
export const Filter = icon(FilterIcon, "Filter");
export const Folder = icon(Folder01Icon, "Folder");
export const FolderInput = icon(FolderInputIcon, "FolderInput");
export const Forward = icon(Redo01Icon, "Forward");
export const HardDrive = icon(HardDriveIcon, "HardDrive");
export const ImageOff = icon(ImageNotFound01Icon, "ImageOff");
export const ImagePlus = icon(ImageAdd01Icon, "ImagePlus");
export const Inbox = icon(InboxIcon, "Inbox");
export const IndentDecrease = icon(TextIndentLessIcon, "IndentDecrease");
export const IndentIncrease = icon(TextIndentMoreIcon, "IndentIncrease");
export const Info = icon(InformationCircleIcon, "Info");
export const Italic = icon(TextItalicIcon, "Italic");
export const Keyboard = icon(KeyboardIcon, "Keyboard");
export const KeyRound = icon(Key02Icon, "KeyRound");
export const Laptop = icon(LaptopIcon, "Laptop");
export const LaptopMinimalCheck = icon(LaptopMinimalCheckIcon, "LaptopMinimalCheck");
export const Layers = icon(Layers01Icon, "Layers");
export const LifeBuoy = icon(LifebuoyIcon, "LifeBuoy");
export const Link = icon(Link01Icon, "Link");
export const Link2 = icon(Link02Icon, "Link2");
export const List = icon(LeftToRightListBulletIcon, "List");
export const ListFilter = icon(ListFilterIcon, "ListFilter");
export const ListOrdered = icon(LeftToRightListNumberIcon, "ListOrdered");
export const Loader2 = icon(Loading03Icon, "Loader2");
export const LoaderCircle = Loader2;
export const Lock = icon(SquareLock02Icon, "Lock");
export const Mail = icon(Mail01Icon, "Mail");
export const MailCheck = icon(MailValidation01Icon, "MailCheck");
export const MailOpen = icon(MailOpen01Icon, "MailOpen");
export const Mails = icon(MailsIcon, "Mails");
export const MessageSquareReply = icon(MessageSquareReplyIcon, "MessageSquareReply");
export const MessageSquareText = icon(Message01Icon, "MessageSquareText");
export const Moon = icon(MoonIcon, "Moon");
export const OctagonAlert = icon(SpamIcon, "OctagonAlert");
export const OctagonX = icon(OctagonXIcon, "OctagonX");
export const Palette = icon(PaintBoardIcon, "Palette");
export const Paperclip = icon(Attachment01Icon, "Paperclip");
export const Pencil = icon(PencilIcon, "Pencil");
export const PenLine = icon(PencilEdit01Icon, "PenLine");
export const Play = icon(PlayIcon, "Play");
export const Plus = icon(Add01Icon, "Plus");
export const Printer = icon(PrinterIcon, "Printer");
export const Redo2 = icon(Redo02Icon, "Redo2");
export const RefreshCw = icon(RefreshIcon, "RefreshCw");
export const RemoveFormatting = icon(TextClearIcon, "RemoveFormatting");
export const Reply = icon(ReplyIcon, "Reply");
export const ReplyAll = icon(ReplyAllIcon, "ReplyAll");
export const RotateCw = icon(RotateClockwiseIcon, "RotateCw");
export const Repeat = icon(RepeatIcon, "Repeat");
export const Rows3 = icon(Layout3RowIcon, "Rows3");
export const Search = icon(Search01Icon, "Search");
export const Send = icon(SentIcon, "Send");
export const Settings2 = icon(Settings02Icon, "Settings2");
export const ShieldCheck = icon(SecurityCheckIcon, "ShieldCheck");
export const SlidersHorizontal = icon(SlidersHorizontalIcon, "SlidersHorizontal");
export const Sparkles = icon(SparklesIcon, "Sparkles");
export const SquarePen = icon(PencilEdit02Icon, "SquarePen");
export const Star = icon(StarIcon, "Star");
export const StarOff = icon(StarOffIcon, "StarOff");
export const Strikethrough = icon(TextStrikethroughIcon, "Strikethrough");
export const Sun = icon(Sun01Icon, "Sun");
export const Tag = icon(Tag01Icon, "Tag");
export const TextAlignCenter = icon(TextAlignCenterIcon, "TextAlignCenter");
export const TextAlignEnd = icon(TextAlignRightIcon, "TextAlignEnd");
export const TextAlignStart = icon(TextAlignLeftIcon, "TextAlignStart");
export const TextQuote = icon(QuoteUpIcon, "TextQuote");
export const Trash2 = icon(Delete02Icon, "Trash2");
export const TriangleAlert = icon(Alert02Icon, "TriangleAlert");
export const Underline = icon(TextUnderlineIcon, "Underline");
export const Undo2 = icon(Undo02Icon, "Undo2");
export const Unlink = icon(Unlink01Icon, "Unlink");
export const Upload = icon(Upload01Icon, "Upload");
export const UserRound = icon(UserCircleIcon, "UserRound");
export const Users = icon(UserMultipleIcon, "Users");
export const Wand2 = icon(MagicWand01Icon, "Wand2");
export const WifiOff = icon(WifiOff01Icon, "WifiOff");
export const X = icon(Cancel01Icon, "X");
