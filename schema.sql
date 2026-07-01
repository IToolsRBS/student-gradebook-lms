-- Core model: Student, Programme, Module, Assessment.
-- Naming convention is normalized to your domain terms.

CREATE TABLE "public"."api_sync_run" (
    "sync_run_id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "started_at" timestamptz NOT NULL DEFAULT now(),
    "finished_at" timestamptz,
    "status" text NOT NULL DEFAULT 'success',
    "notes" text
);

CREATE TABLE "public"."category" (
    "category_id" bigint PRIMARY KEY, -- Moodle category id
    "category_name" text NOT NULL UNIQUE,
    "idnumber" text,
    "description" text,
    "descriptionformat" integer,
    "parent_category_id" bigint REFERENCES "public"."category"("category_id"),
    "sortorder" integer,
    "coursecount" integer,
    "visible" boolean,
    "visibleold" boolean,
    "timemodified_epoch" bigint,
    "depth" integer,
    "path" text,
    "theme" text,
    "last_synced_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "public"."programme" (
    "programme_id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "programme_code" text NOT NULL UNIQUE,
    "programme_name" text NOT NULL,
    "source_category_id" bigint REFERENCES "public"."category"("category_id"),
    "category_id" bigint REFERENCES "public"."category"("category_id"),
    "category" text
);

CREATE TABLE "public"."student" (
    "student_id" bigint PRIMARY KEY, -- Moodle user id
    "programme_id" bigint NOT NULL REFERENCES "public"."programme"("programme_id"),
    "idnumber" text,
    "student_number" text,
    "programme_name" text,
    "email" text,
    "first_name" text,
    "last_name" text,
    "full_name" text,
    "last_synced_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "public"."module" (
    "module_id" bigint PRIMARY KEY, -- Moodle course id
    "programme_id" bigint NOT NULL REFERENCES "public"."programme"("programme_id"),
    "module_code" text, -- Moodle shortname
    "module_name" text NOT NULL, -- Moodle fullname
    "idnumber" text,
    "startdate_epoch" bigint,
    "enddate_epoch" bigint,
    "visible" boolean,
    "last_synced_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "public"."assessment_type" (
    "assessment_type_id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "assessment_type_code" text NOT NULL UNIQUE,
    "assessment_type_name" text NOT NULL
);

CREATE TABLE "public"."assessment" (
    "assessment_id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "module_id" bigint NOT NULL REFERENCES "public"."module"("module_id"),
    "assessment_type_id" bigint REFERENCES "public"."assessment_type"("assessment_type_id"),
    "moodle_grade_item_id" bigint UNIQUE,
    "cmid" bigint,
    "assessment_name" text NOT NULL,
    "assessment_module" text,
    "assessment_item_number" integer,
    "is_course_total" boolean NOT NULL DEFAULT false,
    "last_synced_at" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("module_id", "assessment_name", "assessment_item_number", "is_course_total")
);

CREATE TABLE "public"."student_assessment" (
    "student_id" bigint NOT NULL REFERENCES "public"."student"("student_id"),
    "student_name" text,
    "programme_id" bigint NOT NULL REFERENCES "public"."programme"("programme_id"),
    "programme_name" text,
    "module_id" bigint NOT NULL REFERENCES "public"."module"("module_id"),
    "module_name" text,
    "assessment_id" bigint NOT NULL REFERENCES "public"."assessment"("assessment_id"),
    "assessment_type" text,
    "mark_raw" numeric(10,5),
    "mark_display" text,
    "due_date" text,
    "date_submitted_epoch" bigint,
    "date_graded_epoch" bigint,
    "is_locked" boolean,
    "is_hidden" boolean,
    "synced_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("student_id", "assessment_id"),
    UNIQUE ("student_id", "programme_id", "module_id", "assessment_id")
);

CREATE TABLE "public"."programme_allocation_student_companion" (
    "student_companion" text,
    "programme" text
);
