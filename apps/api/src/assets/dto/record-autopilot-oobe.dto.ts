import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// What a technician saw on a machine's first Windows screen after imaging.
//
// Unlike the station ingest next door, this one DOES validate strictly and
// answer 400 on a bad value. The reason the ingest does not - that a rejected
// record wedges an offline queue forever - does not apply here: this arrives
// from a person at a browser who can be told, immediately, that the answer was
// not understood. And of all the fields in this system, the one that decides
// whether a machine is sellable is the last one that should accept a value it
// could not parse.
export class RecordAutopilotOobeDto {
  @IsIn(['organisation', 'generic', 'blocked'])
  result!: 'organisation' | 'generic' | 'blocked';

  // Required in practice when result is 'organisation' - enforced in the
  // service, where the message can explain why - because an organisation
  // nobody wrote down is most of the value of the observation thrown away.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  organisation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;

  @IsOptional()
  @IsBoolean()
  photographed?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
