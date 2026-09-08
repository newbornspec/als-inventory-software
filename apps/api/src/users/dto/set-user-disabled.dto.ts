import { IsBoolean } from 'class-validator';

// The wire shape stays a boolean even though the column is a timestamp: the UI
// toggles "disabled or not", and the service decides what `now` means. Keeping
// disabledAt off the write DTO means a client can never backdate a disable.
export class SetUserDisabledDto {
  @IsBoolean() disabled: boolean;
}
